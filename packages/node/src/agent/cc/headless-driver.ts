import { spawn as nodeSpawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { AgentEvent, AgentRun, PreparedRun, RunDriver } from '../events.js';
import { NATIVE_SESSION_LOST } from '../events.js';
import { buildCcSettings, writeCcSettings } from './launch.js';
import { FileCcTranscriptWriter, type CcTranscriptWriter } from './transcript.js';
import { errMsg } from '../../util/err.js';
import { assertWindowsJobAvailable, spawnWindowsJob, type WindowsJobChild } from './windows-job.js';

interface ReadableStreamish {
	on(event: 'data', listener: (chunk: Buffer | string) => void): void;
	on(event: 'end' | 'close', listener: () => void): void;
}
export interface CcChild {
	readonly pid?: number;
	readonly stdin: { write(chunk: string): void; end(): void } | null;
	readonly stdout: ReadableStreamish | null;
	readonly stderr: ReadableStreamish | null;
	on(event: 'error', listener: (err: Error) => void): void;
	on(event: 'close', listener: (code: number | null, signal: string | null) => void): void;
	kill(signal?: NodeJS.Signals | number): boolean;
}
export interface CcSpawnOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
	detached: boolean;
	stdio: ['pipe', 'pipe', 'pipe'];
}
export type CcSpawnFn = (command: string, args: readonly string[], options: CcSpawnOptions) => CcChild;
export type CcKillFn = (pid: number, signal?: NodeJS.Signals | number) => void;
export interface CcHeadlessDriverDeps {
	workspaceBase: string;
	brokerPort: number;
	/** Factory-owned hook registry. The driver only sees an opaque conversation key. */
	registerHook: (contextKey: string, attemptId: string, push: (event: AgentEvent) => void) => () => void;
	claudeBin?: string;
	transcript?: CcTranscriptWriter;
	spawn?: CcSpawnFn;
	kill?: CcKillFn;
	firstEventTimeoutMs?: number;
	drainMs?: number;
	killGraceMs?: number;
	stopTimeoutMs?: number;
	/** Injectable only for deterministic POSIX process-group tests on Windows CI. */
	platform?: NodeJS.Platform;
}

const MAX_TOOL_INPUT_CHARS = 2000;
const MAX_CC_LINE_CHARS = 8 * 1024 * 1024;
type Notice = { type: 'line'; text: string } | { type: 'hook'; event: AgentEvent } |
	{ type: 'close'; code: number | null } | { type: 'failure'; message: string } | { type: 'drain-end' };
type StopResult = Awaited<ReturnType<AgentRun['cancel']>>;

/** One invocation per inbound turn; the factory owns the shared broker and hook registry. */
export class CcHeadlessDriver implements RunDriver {
	readonly type = 'cc';
	readonly features = { cancel: 'best-effort', reset: 'supported', promptUpdate: 'per-run' } as const;
	private readonly active = new Set<CcRun>();
	private readonly settings = new Map<string, string>();
	private readonly transcript: CcTranscriptWriter;

	constructor(private readonly deps: CcHeadlessDriverDeps) {
		this.transcript = deps.transcript ?? new FileCcTranscriptWriter();
	}
	async connect(): Promise<void> {
		if ((this.deps.platform ?? process.platform) === 'win32' && !this.deps.spawn) assertWindowsJobAvailable();
	}
	async disconnect(): Promise<void> {
		await Promise.all([...this.active].map((run) => run.cancel('driver disconnect')));
	}
	createRun(input: PreparedRun): AgentRun {
		if (!input.runId || !input.conversation || !input.signal || typeof input.message !== 'string' ||
			!input.workspace || !input.contextKey || !input.bindToken) throw new TypeError('Invalid CC prepared run');
		const run = new CcRun(input, this.deps, this.transcript, async (workspace) => {
			await mkdir(workspace, { recursive: true });
			let path = this.settings.get(workspace);
			if (!path) {
				path = writeCcSettings(workspace, buildCcSettings(this.deps.brokerPort));
				this.settings.set(workspace, path);
			}
			return path;
		}, () => this.active.delete(run));
		this.active.add(run);
		return run;
	}
}

class CcRun implements AgentRun {
	private child: CcChild | undefined;
	private closed = false;
	private groupGone = false;
	private submitted = false;
	private finished = false;
	private consuming = false;
	private cancelled = false;
	private stopPromise?: Promise<StopResult>;
	private deregister?: () => void;
	private timer?: ReturnType<typeof setTimeout>;
	private notices: Notice[] = [];
	private wake?: () => void;
	private readonly startedAt = Date.now();
	private readonly spawn: CcSpawnFn;
	private readonly kill: CcKillFn;
	private stdout = '';
	private stdoutOverflow = false;
	private readonly stdoutDecoder = new StringDecoder('utf8');
	private stderr = '';

	constructor(
		private readonly input: PreparedRun,
		private readonly deps: CcHeadlessDriverDeps,
		private readonly transcript: CcTranscriptWriter,
		private readonly settingsPath: (workspace: string) => Promise<string>,
		private readonly onFinished: () => void,
	) {
		this.spawn = deps.spawn ?? ((deps.platform ?? process.platform) === 'win32'
			? spawnWindowsJob : nodeSpawn as unknown as CcSpawnFn);
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
		if ((this.deps.platform ?? process.platform) === 'win32')
			return (this.child as WindowsJobChild | undefined)?.verifiedGone === true;
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
		this.deregister?.();
		this.deregister = undefined;
		if (!this.submitted || this.groupGone) this.onFinished();
	}
	private readonly onAbort = () => { void this.cancel('aborted'); };

	get events(): AsyncIterable<AgentEvent> {
		return { [Symbol.asyncIterator]: () => {
			if (this.consuming) throw new Error('CC run events can be consumed only once');
			this.consuming = true;
			return this.execute();
		} };
	}

	private async *execute(): AsyncGenerator<AgentEvent> {
		const { input } = this;
		const contextKey = input.contextKey!; // validated synchronously by createRun
		let sessionId: string | undefined;
		let resultError: string | undefined;
		let resultSeen = false;
		let initSeen = false;
		try {
			if (this.cancelled || input.signal.aborted) { yield { type: 'cancelled', reason: 'Cancelled before submission' }; return; }
			input.signal.addEventListener('abort', this.onAbort, { once: true });
			const workspace = input.workspace!;
			const settings = await this.settingsPath(workspace);
			if (this.cancelled || input.signal.aborted) { yield { type: 'cancelled', reason: 'Cancelled before submission' }; return; }
			const previous = input.conversation.nativeState?.value;
			if (previous !== undefined && (!previous || typeof previous !== 'object' ||
				!('sessionId' in previous) || typeof previous.sessionId !== 'string' ||
				('cwdConfirmationRequired' in previous && previous.cwdConfirmationRequired === true) ||
				!('workspace' in previous) || typeof previous.workspace !== 'string' ||
				previous.workspace !== workspace)) {
				throw new Error('CC original cwd unconfirmed, mismatched or invalid; owner-confirm original cwd offline or reset explicitly');
			}
			sessionId = previous && 'sessionId' in previous ? previous.sessionId as string : undefined;
			// #382: non-empty → this attempt must CONTINUE the persisted session; a pre-init exit then
			// means the resume itself failed, not a mid-run execution failure.
			const resumedFrom = sessionId;
			const argv = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
				'--include-partial-messages', '--allowedTools', 'Bash(aichat:*)', '--settings', settings];
			if (input.systemPrompt) argv.push('--append-system-prompt', input.systemPrompt);
			if (sessionId) argv.push('--resume', sessionId);
			const attempt = `${input.runId}:${randomUUID()}`;
			const env: NodeJS.ProcessEnv = { ...process.env, AICHAT_CONTEXT_KEY: contextKey,
				AICHAT_BIND: input.bindToken, AICHAT_CC_RUN: attempt, CLAUDE_NON_INTERACTIVE: '1' };
			delete env.OPENCODE_SESSION_ID;
			delete env.CODEX_THREAD_ID;
			delete env.OPENCLAW_BIND;
			input.conversation.assertCurrent();
			if (this.cancelled || input.signal.aborted) { yield { type: 'cancelled', reason: 'Cancelled before submission' }; return; }
			this.deregister = this.deps.registerHook(contextKey, attempt,
				(ev) => this.notify({ type: 'hook', event: ev }));
			await input.saveRecovery({ version: 1, value: { provider: 'cc', runId: input.runId,
				attempt, sessionId: sessionId ?? null, workspace, stopProbe: 'unknown-after-restart' } });
			input.conversation.assertCurrent();
			if (this.cancelled || input.signal.aborted) { yield { type: 'cancelled', reason: 'Cancelled before submission' }; return; }
			this.child = this.spawn(this.deps.claudeBin ?? 'claude', argv, {
				cwd: workspace, env, detached: (this.deps.platform ?? process.platform) !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
			});
			this.submitted = true;
			this.transcript.append(input.transcriptKey ?? contextKey, { ts: this.startedAt, session_id: sessionId, kind: 'inbound', text: input.message });
			this.timer = setTimeout(() => this.notify({ type: 'failure', message: 'first-event timeout' }), this.deps.firstEventTimeoutMs ?? 90_000);
			this.child.stdout?.on('data', (chunk) => {
				if (this.stdoutOverflow) return;
				this.stdout += typeof chunk === 'string' ? chunk : this.stdoutDecoder.write(chunk);
				let pos: number;
				while ((pos = this.stdout.indexOf('\n')) >= 0) {
					if (pos > MAX_CC_LINE_CHARS) break;
					this.notify({ type: 'line', text: this.stdout.slice(0, pos) });
					this.stdout = this.stdout.slice(pos + 1);
				}
				if (this.stdout.length > MAX_CC_LINE_CHARS) {
					this.stdoutOverflow = true;
					this.stdout = '';
					this.notify({ type: 'failure', message: 'CC stdout line exceeded 8 MiB' });
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
			if ((this.deps.platform ?? process.platform) === 'win32' && !this.deps.spawn)
				await (this.child as WindowsJobChild).ready; // persist real assigned PID before submitting input
			// Persist the exact process locator before submitting input; a crash before init must not lose it.
			await input.saveRecovery({ version: 1, value: { provider: 'cc', runId: input.runId,
				attempt, sessionId: sessionId ?? null, workspace, pid: this.child.pid ?? null,
				stopProbe: 'unknown-after-restart' } });
			if (this.cancelled || input.signal.aborted) {
				await this.cancel('cancelled before native submit');
				yield { type: 'cancelled', reason: 'Cancelled before native submit' };
				return;
			}
			input.conversation.assertCurrent();
			const envelope = { type: 'user', message: { role: 'user', content: [{ type: 'text', text: input.message }] } };
			this.child.stdin?.write(`${JSON.stringify(envelope)}\n`);
			this.child.stdin?.end();
			while (true) {
				const notice = await this.next();
				if (notice.type === 'failure') { resultError = notice.message; break; }
				if (notice.type === 'close') {
					if (!this.groupGone) resultError = 'CC process group exit unconfirmed';
					else if (notice.code !== 0) resultError = resultError ?? `claude exited ${notice.code}: ${this.stderr}`;
					else if (!resultSeen) resultError = 'UNEXPECTED_EOF';
					break;
				}
				if (notice.type === 'hook') { yield notice.event; continue; }
				if (notice.type !== 'line') continue;
				let obj: Record<string, unknown>;
				try { obj = JSON.parse(notice.text.trim().replace(/^data:\s*/, '')) as Record<string, unknown>; }
				catch { continue; }
				if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
				if (obj.type === 'system' && obj.subtype === 'init' && typeof obj.session_id === 'string' && obj.session_id) {
						sessionId = obj.session_id;
					initSeen = true; // #382: resume accepted — later failures are execution failures, not "history lost"
					try {
						await input.conversation.saveNativeState({ version: 1, value: {
							...(previous && typeof previous === 'object' && 'sessionId' in previous && previous.sessionId === sessionId
								? previous : {}), sessionId, workspace,
						} });
						await input.saveRecovery({ version: 1, value: { provider: 'cc', runId: input.runId,
							attempt, sessionId, workspace, pid: this.child.pid ?? null, stopProbe: 'unknown-after-restart' } });
					} catch (error) { resultError = `session registration failed: ${errMsg(error)}`; break; }
				} else if (obj.type === 'result') {
					resultSeen = true;
					if (obj.is_error === true || obj.subtype === 'error_during_execution')
						resultError = `claude result error: ${Array.isArray(obj.errors) ? obj.errors.join('; ') : obj.subtype}`;
				} else if (obj.type === 'assistant' && obj.message && typeof obj.message === 'object') {
					const content = (obj.message as { content?: unknown }).content;
					if (!Array.isArray(content)) continue;
					for (const block of content as Array<Record<string, unknown>>) {
						const ts = Date.now();
						if (block.type === 'text' && typeof block.text === 'string') {
							this.transcript.append(input.transcriptKey ?? contextKey, { ts, session_id: sessionId, kind: 'assistant', text: block.text });
							yield { type: 'thinking', text: block.text };
						} else if (block.type === 'thinking' && typeof block.thinking === 'string') {
							this.transcript.append(input.transcriptKey ?? contextKey, { ts, session_id: sessionId, kind: 'thinking', text: block.thinking });
							yield { type: 'thinking', text: block.thinking };
						} else if (block.type === 'tool_use' && typeof block.name === 'string') {
							const json = block.input === undefined ? undefined : JSON.stringify(block.input);
							this.transcript.append(input.transcriptKey ?? contextKey, { ts, session_id: sessionId, kind: 'tool_use', tool: block.name,
								...(json === undefined ? {} : { tool_input: json.length > MAX_TOOL_INPUT_CHARS
									? `${json.slice(0, MAX_TOOL_INPUT_CHARS)}…[truncated ${json.length - MAX_TOOL_INPUT_CHARS} chars]` : json }) });
						}
					}
				}
			}
			// #382: a resume attempt that died BEFORE init with CC's own "No conversation found" wording
			// (live-observed on a container-rebuilt host whose ~/.claude history was lost) proves the
			// persisted session non-resumable. Stamp the shared code so the bridge can fail visibly and
			// move the room into the explainable pause instead of leaving a silent status=2 trace.
			if (resultError && resumedFrom && !initSeen && /no conversation found/i.test(resultError))
				resultError = `${NATIVE_SESSION_LOST}: ${resultError}`;
			if (resultError && !this.groupGone) await this.cancel(resultError);
			if (this.cancelled && !this.groupGone) yield { type: 'cancelled', reason: 'CC stop unconfirmed' };
			else if (resultError) yield { type: 'error', message: resultError };
			else if (this.cancelled) yield { type: 'cancelled', reason: 'CC cancelled' };
			else {
				// The final async PostToolUse hook may reach the broker after stdout/child close.
				// Preserve its run-scoped ordering before the terminal event during the drain window.
				const timer = setTimeout(() => this.notify({ type: 'drain-end' }), this.deps.drainMs ?? 250);
				try {
					while (true) {
						const notice = await this.next();
						if (notice.type === 'drain-end') break;
						if (notice.type === 'hook' && !this.cancelled) yield notice.event;
					}
				} finally { clearTimeout(timer); }
				if (this.cancelled) yield { type: 'cancelled', reason: 'CC cancelled during hook drain' };
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
		if ((this.deps.platform ?? process.platform) === 'win32' && !this.deps.spawn)
			(this.child as WindowsJobChild).forceKillHelper(); // close owned Job handle; still unconfirmed
		return { status: 'unconfirmed', reason: `${reason}: child close and process-group exit not both verified` };
	}
	async dispose(): Promise<void> {
		this.deregister?.();
		this.deregister = undefined;
		if (this.timer) clearTimeout(this.timer);
		if (!this.finished && !this.groupGone) await this.cancel('dispose');
		this.finish();
	}
}
