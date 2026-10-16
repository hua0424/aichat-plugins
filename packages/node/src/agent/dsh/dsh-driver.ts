import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import type { AgentEvent, AgentRun, PreparedRun, RunDriver } from '../events.js';
import { NATIVE_SESSION_LOST } from '../events.js';
import { mapDshLine } from './events.js';
import { errMsg } from '../../util/err.js';

/** dsh headless `--json` pinned runtime (aichatoverview#415; locked at #425). */
export const DSH_EXPECTED_VERSION = '0.2.0-rc.2';

/** Native env key carrying the DSH session id (mirrors OPENCODE_SESSION_ID / CODEX_THREAD_ID). */
export const DSH_SESSION_ENV = 'DSH_SESSION_ID';

interface ReadableStreamish {
	on(event: 'data', listener: (chunk: Buffer | string) => void): void;
	on(event: 'end' | 'close', listener: () => void): void;
}
export interface DshChild {
	readonly pid?: number;
	readonly stdin: { write(chunk: string): void; end(): void } | null;
	readonly stdout: ReadableStreamish | null;
	readonly stderr: ReadableStreamish | null;
	on(event: 'error', listener: (err: Error) => void): void;
	on(event: 'close', listener: (code: number | null, signal: string | null) => void): void;
	kill(signal?: NodeJS.Signals | number): boolean;
}
export interface DshSpawnOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
	detached: boolean;
	stdio: ['pipe', 'pipe', 'pipe'];
}
export type DshSpawnFn = (command: string, args: readonly string[], options: DshSpawnOptions) => DshChild;
export type DshKillFn = (pid: number, signal?: NodeJS.Signals | number) => void;
export interface DshHeadlessDriverDeps {
	dshBin?: string;
	expectedVersion?: string;
	spawn?: DshSpawnFn;
	kill?: DshKillFn;
	firstEventTimeoutMs?: number;
	killGraceMs?: number;
	stopTimeoutMs?: number;
	/** Injectable only for deterministic POSIX process-group tests on Windows CI. */
	platform?: NodeJS.Platform;
}

type Notice = { type: 'line'; text: string } | { type: 'failure'; message: string } | { type: 'close'; code: number | null };
type StopResult = Awaited<ReturnType<AgentRun['cancel']>>;

const MAX_DSH_LINE_CHARS = 8 * 1024 * 1024;

/** One invocation per inbound turn; the headless dsh process exits after the turn. */
export class DshHeadlessDriver implements RunDriver {
	readonly type = 'dsh';
	readonly features = { cancel: 'best-effort', reset: 'supported', promptUpdate: 'new-session' } as const;
	private readonly active = new Set<DshRun>();
	constructor(private readonly deps: DshHeadlessDriverDeps = {}) {}
	async connect(): Promise<void> {
		// #421: unknown dsh versions isolate ONLY this identity — the message must not
		// match the supervisor's transient pattern (no starting/timeout/unavailable…),
		// so a version mismatch degrades without pointless retries of other identities.
		const bin = this.deps.dshBin ?? 'dsh';
		const expected = this.deps.expectedVersion ?? DSH_EXPECTED_VERSION;
		const version = await readVersion(bin, this.deps.spawn);
		if (version !== expected)
			throw new Error(`dsh version mismatch: expected ${expected}, got ${version || 'unknown'} — refusing to run`);
	}
	async disconnect(): Promise<void> {
		await Promise.all([...this.active].map((run) => run.cancel('driver disconnect')));
	}
	createRun(input: PreparedRun): AgentRun {
		if (!input.runId || !input.conversation || !input.signal || typeof input.message !== 'string' ||
			!input.workspace || typeof input.systemPrompt !== 'string' || !input.contextKey || !input.replyToken)
			throw new TypeError('Invalid DSH prepared run');
		const run = new DshRun(input, this.deps, () => this.active.delete(run));
		this.active.add(run);
		return run;
	}
}

/** Best-effort `dsh --version` read through the same injectable spawn seam. */
function readVersion(bin: string, spawn?: DshSpawnFn): Promise<string> {
	return new Promise((resolve) => {
		let out = '';
		try {
			const child = (spawn ?? (nodeSpawn as unknown as DshSpawnFn))(bin, ['--version'], {
				cwd: process.cwd(), env: process.env, detached: false, stdio: ['pipe', 'pipe', 'pipe'],
			});
			child.stdout?.on('data', (chunk) => { out += chunk.toString(); });
			child.on('error', () => resolve(''));
			child.on('close', () => resolve(out.trim()));
			setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* best-effort */ } }, 10_000).unref?.();
		} catch { resolve(''); }
	});
}

class DshRun implements AgentRun {
	private child: DshChild | undefined;
	private closed = false;
	private groupGone = false;
	private submitted = false;
	private finished = false;
	private cancelled = false;
	private stopPromise?: Promise<StopResult>;
	private timer?: ReturnType<typeof setTimeout>;
	private notices: Notice[] = [];
	private consuming = false;
	private wake?: () => void;
	private readonly startedAt = Date.now();
	private readonly spawn: DshSpawnFn;
	private readonly kill: DshKillFn;
	private stdout = '';
	private stdoutOverflow = false;
	private readonly stdoutDecoder = new StringDecoder('utf8');
	private stderr = '';
	private readonly onAbort = () => { void this.cancel('aborted'); };

	constructor(
		private readonly input: PreparedRun,
		private readonly deps: DshHeadlessDriverDeps,
		private readonly onFinished: () => void,
	) {
		this.spawn = deps.spawn ?? (nodeSpawn as unknown as DshSpawnFn);
		this.kill = deps.kill ?? ((pid, signal) => { process.kill(pid, signal); });
	}

	private notify(notice: Notice): void {
		this.notices.push(notice);
		this.wake?.();
	}
	private async next(): Promise<Notice> {
		while (!this.notices.length) await new Promise<void>((resolve) => { this.wake = resolve; });
		this.wake = undefined;
		return this.notices.shift()!;
	}
	private probeGroup(): boolean {
		if ((this.deps.platform ?? process.platform) === 'win32') return this.closed;
		const pid = this.child?.pid;
		if (!Number.isSafeInteger(pid) || !pid || pid <= 0) return false;
		try { this.kill(-pid, 0); return false; }
		catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
	}
	private signalGroup(signal: NodeJS.Signals): void {
		const pid = this.child?.pid;
		try {
			if ((this.deps.platform ?? process.platform) === 'win32') this.child?.kill(signal);
			else if (Number.isSafeInteger(pid) && pid && pid > 0) this.kill(-pid, signal);
		} catch { /* probe, not a sent signal, determines stop */ }
	}
	private finish(): void {
		if (this.finished) return;
		this.finished = true;
		if (this.timer) clearTimeout(this.timer);
		if (!this.submitted || this.groupGone) this.onFinished();
	}
	get events(): AsyncIterable<AgentEvent> {
		return { [Symbol.asyncIterator]: () => {
			if (this.consuming) throw new Error('DSH run events can be consumed only once');
			this.consuming = true;
			return this.run();
		} };
	}

	private async *run(): AsyncGenerator<AgentEvent> {
		const { input } = this;
		const contextKey = input.contextKey!; // validated synchronously by createRun
		const replyToken = input.replyToken!; // validated synchronously by createRun
		const workspace = input.workspace!; // validated synchronously by createRun
		const digest = createHash('sha256').update(input.systemPrompt).digest('hex');
		// #424: prompt-hash gate (codex frozen-prompt analog) — a persona change never
		// silently drifts an old session; the owner resets explicitly, history retained.
		const previous = input.conversation.nativeState?.value;
		if (previous !== undefined && (!previous || typeof previous !== 'object' ||
			!('sessionId' in previous) || typeof previous.sessionId !== 'string' || !previous.sessionId ||
			('workspace' in previous && previous.workspace !== workspace) ||
			('promptHash' in previous && previous.promptHash !== digest)))
			throw new Error('DSH native session invalid or persona/workspace mismatch; explicit reset required (history retained)');
		const sessionId = previous && typeof previous === 'object' && 'sessionId' in previous
			? previous.sessionId as string : undefined;
		// Accumulators for the lossless-final rule: final text is yielded only when it
		// adds bytes beyond the streamed text blocks (truncated stream or textless run).
		let streamedTextRaw = '';
		let finalText: string | undefined;
		let turnCompleted: boolean | undefined;
		let turnDetail: string | undefined;
		let lastErrorLine: string | undefined;
		const toolNames = new Map<string, string>();
		try {
			if (this.cancelled || input.signal.aborted) { yield { type: 'cancelled', reason: 'Cancelled before submission' }; return; }
			input.signal.addEventListener('abort', this.onAbort, { once: true });
			await mkdir(workspace, { recursive: true });
			if (this.cancelled || input.signal.aborted) { yield { type: 'cancelled', reason: 'Cancelled before submission' }; return; }
			input.conversation.assertCurrent();
			if (this.cancelled || input.signal.aborted) { yield { type: 'cancelled', reason: 'Cancelled before submission' }; return; }
			// dsh headless takes no per-run system flag: the prepared prompt (persona +
			// templates, rendered once at the core boundary) rides as the task prefix —
			// the spawn-carried analog of cc --append-system-prompt / codex
			// developer_instructions. Task via stdin (`-`) avoids argv length caps.
			const task = input.systemPrompt ? `${input.systemPrompt}\n\n${input.message}` : input.message;
			const argv = ['--profile', 'headless', '--json'];
			if (sessionId) argv.push('--session-id', sessionId);
			argv.push('-');
			// #404: every run carries exactly one frozen reply binding; inherited values
			// from an outer run env are overwritten, never merged.
			const env: NodeJS.ProcessEnv = { ...process.env, AICHAT_CONTEXT_KEY: contextKey, AICHAT_RUN_BIND: replyToken };
			if (sessionId) env[DSH_SESSION_ENV] = sessionId;
			else delete env[DSH_SESSION_ENV];
			delete env.OPENCODE_SESSION_ID;
			delete env.CODEX_THREAD_ID;
			delete env.OPENCLAW_BIND;
			delete env.AICHAT_BIND;
			delete env.AICHAT_CC_RUN;
			await input.saveRecovery({ version: 1, value: { provider: 'dsh', runId: input.runId,
				sessionId: sessionId ?? null, workspace, stopProbe: 'unknown-after-restart' } });
			input.conversation.assertCurrent();
			if (this.cancelled || input.signal.aborted) { yield { type: 'cancelled', reason: 'Cancelled before submission' }; return; }
			this.child = this.spawn(this.deps.dshBin ?? 'dsh', argv, {
				cwd: workspace, env, detached: (this.deps.platform ?? process.platform) !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
			});
			this.submitted = true;
			this.timer = setTimeout(() => this.notify({ type: 'failure', message: 'first-event timeout' }), this.deps.firstEventTimeoutMs ?? 90_000);
			this.child.stdout?.on('data', (chunk) => {
				if (this.stdoutOverflow) return;
				this.stdout += typeof chunk === 'string' ? chunk : this.stdoutDecoder.write(chunk);
				let pos: number;
				while ((pos = this.stdout.indexOf('\n')) >= 0) {
					if (pos > MAX_DSH_LINE_CHARS) break;
					this.notify({ type: 'line', text: this.stdout.slice(0, pos) });
					this.stdout = this.stdout.slice(pos + 1);
				}
				if (this.stdout.length > MAX_DSH_LINE_CHARS) {
					this.stdoutOverflow = true;
					this.stdout = '';
					this.notify({ type: 'failure', message: 'DSH stdout line exceeded 8 MiB' });
				}
			});
			this.child.stdout?.on('end', () => {
				if (this.stdoutOverflow) return;
				this.stdout += this.stdoutDecoder.end();
				if (this.stdout.trim()) this.notify({ type: 'line', text: this.stdout });
			});
			this.child.stderr?.on('data', (chunk) => { this.stderr = (this.stderr + chunk.toString()).slice(-500); });
			this.child.on('error', (err) => this.notify({ type: 'failure', message: errMsg(err) }));
			this.child.on('close', (code) => {
				this.closed = true;
				this.groupGone = this.probeGroup();
				this.notify({ type: 'close', code });
			});
			if (this.cancelled || input.signal.aborted) {
				await this.cancel('cancelled before native submit');
				yield { type: 'cancelled', reason: 'Cancelled before native submit' };
				return;
			}
			input.conversation.assertCurrent();
			this.child.stdin?.write(`${task}\n`);
			this.child.stdin?.end();
			let closeCode: number | null | undefined;
			let failed: string | undefined;
			while (true) {
				const notice = await this.next();
				if (notice.type === 'failure') { failed = notice.message; break; }
				if (notice.type === 'close') { closeCode = notice.code; break; }
				if (notice.type !== 'line') continue;
				let obj: unknown;
				try { obj = JSON.parse(notice.text); }
				catch { continue; } // stdout carries only --json lines; tolerate strays
				if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
				const mapped = mapDshLine(obj);
				switch (mapped.kind) {
					case 'session': {
						try {
							await input.conversation.saveNativeState({ version: 1, value: {
								sessionId: mapped.sessionId, workspace, promptHash: digest,
							} });
							await input.saveRecovery({ version: 1, value: { provider: 'dsh', runId: input.runId,
								sessionId: mapped.sessionId, workspace, stopProbe: 'unknown-after-restart' } });
						} catch (error) { failed = `session registration failed: ${errMsg(error)}`; break; }
						continue;
					}
					case 'thinking':
						if (mapped.text !== '') {
							streamedTextRaw += mapped.text;
							yield { type: 'thinking', text: mapped.text };
						}
						continue;
					case 'tool': {
						let name = mapped.name;
						if (mapped.callId) {
							if (mapped.phase === 'start') toolNames.set(mapped.callId, name);
							else if (toolNames.has(mapped.callId)) name = toolNames.get(mapped.callId)!;
						}
						yield { type: 'tool', name, phase: mapped.phase };
						continue;
					}
					case 'final':
						finalText = mapped.text;
						continue;
					case 'turn-end':
						turnCompleted = mapped.completed;
						turnDetail = mapped.detail;
						continue;
					case 'error-line':
						// #423: an error line never terminates the run by itself — stashed
						// as context; the terminal verdict comes from exit + turn_end below.
						lastErrorLine = mapped.message;
						continue;
					case 'ignore':
						continue;
				}
			}
			if (failed && !this.groupGone) await this.cancel(failed);
			if (this.cancelled && !this.groupGone) yield { type: 'cancelled', reason: 'DSH stop unconfirmed' };
			else if (failed) yield { type: 'error', message: failed };
			else if (this.cancelled) yield { type: 'cancelled', reason: 'DSH cancelled' };
			else {
				// Terminal verdict from exit code + turn_end only (#417, #423): error lines
				// above are context, never the verdict. Lossless final: yield it when it
				// adds bytes beyond the streamed text (truncated stream or textless run).
				if (finalText !== undefined && finalText !== '' && !streamedTextRaw.endsWith(finalText))
					yield { type: 'thinking', text: finalText };
				if (closeCode !== 0)
					yield { type: 'error', message: `dsh exited ${closeCode ?? 'unknown'}: ${this.stderr}${lastErrorLine ? ` — ${lastErrorLine}` : ''}` };
				else if (turnCompleted !== true)
					yield { type: 'error', message: turnDetail ?? (lastErrorLine ? `dsh turn failed: ${lastErrorLine}` : 'UNEXPECTED_EOF') };
				else yield { type: 'done', durationMs: Date.now() - this.startedAt };
			}
		} catch (error) {
			if (this.submitted && !this.groupGone) await this.cancel(errMsg(error));
			yield { type: 'error', message: errMsg(error) };
		} finally {
			input.signal.removeEventListener('abort', this.onAbort);
			this.finish();
		}
	}

	async cancel(reason: string): Promise<StopResult> {
		this.cancelled = true;
		if (!this.submitted && !this.consuming) this.finish();
		return this.stopPromise ??= this.stop(reason).then((result) => {
			if (result.status === 'stopped') this.onFinished();
			else this.stopPromise = undefined; // a later shutdown can re-probe a formerly unconfirmed group
			return result;
		});
	}
	private async stop(reason: string): Promise<StopResult> {
		if (!this.submitted) return { status: 'stopped' };
		if (this.closed && this.groupGone) return { status: 'stopped' };
		this.signalGroup('SIGTERM');
		const timeout = this.deps.stopTimeoutMs ?? 10_000;
		const started = Date.now();
		let escalated = false;
		while (Date.now() - started < timeout) {
			if (this.closed && this.probeGroup()) {
				this.groupGone = true;
				return { status: 'stopped' };
			}
			if (!escalated && Date.now() - started >= (this.deps.killGraceMs ?? 2_000)) {
				escalated = true;
				this.signalGroup('SIGKILL');
			}
			await new Promise<void>((resolve) => setTimeout(resolve, Math.max(1, Math.min(20, timeout - (Date.now() - started)))));
		}
		return { status: 'unconfirmed', reason: `${reason}: child close and process-group exit not both verified` };
	}
	async dispose(): Promise<void> {
		if (!this.finished) await this.cancel('dispose');
	}
}
