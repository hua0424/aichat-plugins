import { mkdir } from 'node:fs/promises';
import { spawn as nodeSpawn } from 'node:child_process';
import type { AgentDriver, AgentSession, AgentEvent } from '../events.js';
import { deriveWorkspaceDir, type OpencodeChatContext } from '../opencode/workspace.js';
import { parseCcBinding } from './cc-driver.js';
import { buildCcSettings, writeCcSettings, CC_REPLY_CONTRACT } from './launch.js';
import type { CcHeadlessSessionStore } from './headless-session-store.js';
import type { CcSessionRegistry } from './sink.js';
import { FileCcTranscriptWriter, type CcTranscriptWriter } from './transcript.js';

/**
 * REQ-011 S3 — build the cc stdin channel content with per-sender attribution (anti-prompt-injection).
 *
 * VERBATIM the format resurrected from commit 645fec2 (do NOT re-invent): a NATURAL chat transcript,
 * NOT bare/imperative text. CC's anti-prompt-injection is stronger than the other three drivers (they
 * tolerate a bare current message; CC refuses bare / "do X silently" channel text but processes a
 * naturally-attributed chat message and replies as the room's assistant), so attribution is cc-specific
 * and lives here in the driver — never a handler behaviour branch.
 *   DM    (roomType===2) → `[HuLa 私聊]\n[fromName(fromUid)]: <message>`
 *   group (else)         → `[HuLa 群聊]\n<accumulated lines>\n[fromName(fromUid)]: <current>`
 */
export function buildCcChannelContent(o: {
	roomType: number;
	fromName: string;
	fromUid: number;
	accumulated: string[];
	message: string;
}): string {
	const room = o.roomType === 2 ? '[HuLa 私聊]' : '[HuLa 群聊]';
	const currentLine = `[${o.fromName}(${o.fromUid})]: ${o.message}`;
	const lines = o.accumulated.length > 0 ? [...o.accumulated, currentLine] : [currentLine];
	return `${room}\n${lines.join('\n')}`;
}

/**
 * REQ-011 S2 — CcHeadlessDriver: claude-code as the FOURTH node-driven AgentDriver (after openclaw,
 * opencode, codex). The channel approach was abandoned; CC now runs HEADLESS, spawned per inbound turn.
 *
 * A deliberate HYBRID: `drivesTurns=true` (node drives the turn, like the other three), but the reply
 * and thinking exits are UNCHANGED from the owner-driven model:
 *   - REPLY    = CC itself runs `aichat send-message` (the #102 capability CLI, out-of-band). NOT parsed
 *                from stdout.
 *   - THINKING = sourced from CC's HOOKS (which fire under headless), POSTed to the CcBroker and bridged
 *                into THIS session's AgentEvent stream via the CcSessionRegistry, so the handler's
 *                standard reduceThinking path renders the panel. NOT parsed from stdout.
 *   - STDOUT   = CONTROL-PLANE ONLY: capture `session_id` (system/init), detect turn-complete
 *                (`result` event / EOF), first-event timeout, errors. NO assistant/reply/thinking text
 *                is parsed from stdout (it would conflict with the CLI reply).
 *
 * Per-turn spawn (PoC-verified, claude-code 2.1.195):
 *   claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages
 *          --allowedTools 'Bash(aichat:*)' --settings <path> [--resume <session_id>]
 * The prompt is a stream-json user envelope written to STDIN, then stdin is closed (EOF) → claude runs
 * one turn, emits a `result` event, and exits 0. `--dangerously-skip-permissions` is rejected as root,
 * so `--allowedTools 'Bash(aichat:*)'` grants the reply CLI unattended. `--resume` keeps session
 * continuity across turns/restarts (session_id persisted in the store, keyed by (uid,room)).
 */

/** The slice of a Node readable stream this driver consumes (stdout/stderr). */
interface ReadableStreamish {
	on(event: 'data', listener: (chunk: Buffer | string) => void): void;
	on(event: 'end' | 'close', listener: () => void): void;
}

/** The slice of a spawned child process this driver needs. Structurally satisfied by ChildProcess. */
export interface CcChild {
	readonly pid?: number;
	readonly stdin: { write(chunk: string): void; end(): void } | null;
	readonly stdout: ReadableStreamish | null;
	readonly stderr: ReadableStreamish | null;
	on(event: 'error', listener: (err: Error) => void): void;
	on(event: 'exit' | 'close', listener: (code: number | null, signal: string | null) => void): void;
	kill(signal?: NodeJS.Signals | number): boolean;
}

/** Spawn function shape (injectable; defaults to node:child_process.spawn). */
export type CcSpawnFn = (command: string, args: readonly string[], options: CcSpawnOptions) => CcChild;

export interface CcSpawnOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
	detached: boolean;
	stdio: ['pipe', 'pipe', 'pipe'];
}

/** Kill a pid (or process group when pid is negative); injectable, defaults to process.kill. */
export type CcKillFn = (pid: number, signal?: NodeJS.Signals | number) => void;

export interface CcHeadlessDriverDeps {
	/** claude binary (path or bare `claude` on PATH). Default 'claude'. */
	claudeBin?: string;
	/** Root under which per-conversation CC workspaces are derived (e.g. ~/.aichat/cc/workspace). */
	workspaceBase: string;
	/** The node-local CcBroker port the generated settings hooks POST to. */
	brokerPort: number;
	/** Persisted (uid,room)→session_id map for cross-turn/restart `--resume`. */
	sessionStore: CcHeadlessSessionStore;
	/** Per-room bridge: hooks routed by the broker land in the active session's stream via this. */
	registry: CcSessionRegistry;
	/**
	 * REQ-011 S3 (AC5/AC9): per-room append-only transcript sink (inbound + teed CC output). Injectable
	 * for tests; defaults to the file-backed writer under ~/.aichat/cc/transcripts.
	 */
	transcript?: CcTranscriptWriter;
	/** Spawn fn (injectable for tests). Default node:child_process.spawn. */
	spawn?: CcSpawnFn;
	/** Kill fn (injectable for tests). Default process.kill. */
	kill?: CcKillFn;
	/** First-event (stdout) watchdog; if no stdout event within this window → error + kill. Default 90s. */
	firstEventTimeoutMs?: number;
	/**
	 * After turn-complete (stdout `result`/EOF), wait this long before yielding `done`, so a final
	 * thinking hook POST still racing over loopback HTTP lands in the queue BEFORE done. Default 250ms.
	 */
	drainMs?: number;
	/** Grace before escalating SIGTERM→SIGKILL on the process group. Default 2s. */
	killGraceMs?: number;
}

const DEFAULT_FIRST_EVENT_TIMEOUT_MS = 90_000;
const DEFAULT_DRAIN_MS = 250;
const DEFAULT_KILL_GRACE_MS = 2_000;

export class CcHeadlessDriver implements AgentDriver {
	readonly type = 'cc';
	/** Node DRIVES cc turns now (headless, spawn-per-turn) — the standard supervised path applies. */
	readonly drivesTurns = true;

	private readonly claudeBin: string;
	private readonly workspaceBase: string;
	private readonly brokerPort: number;
	private readonly sessionStore: CcHeadlessSessionStore;
	private readonly registry: CcSessionRegistry;
	private readonly transcript: CcTranscriptWriter;
	private readonly spawn: CcSpawnFn;
	private readonly kill: CcKillFn;
	private readonly firstEventTimeoutMs: number;
	private readonly drainMs: number;
	private readonly killGraceMs: number;

	/** Active sessions, so node teardown (disconnect) reaps every spawned child's process group. */
	private readonly active = new Set<CcHeadlessSession>();

	constructor(deps: CcHeadlessDriverDeps) {
		this.claudeBin = deps.claudeBin ?? 'claude';
		this.workspaceBase = deps.workspaceBase;
		this.brokerPort = deps.brokerPort;
		this.sessionStore = deps.sessionStore;
		this.registry = deps.registry;
		this.transcript = deps.transcript ?? new FileCcTranscriptWriter();
		this.spawn = deps.spawn ?? (nodeSpawn as unknown as CcSpawnFn);
		this.kill = deps.kill ?? ((pid, signal) => void process.kill(pid, signal));
		this.firstEventTimeoutMs = deps.firstEventTimeoutMs ?? DEFAULT_FIRST_EVENT_TIMEOUT_MS;
		this.drainMs = deps.drainMs ?? DEFAULT_DRAIN_MS;
		this.killGraceMs = deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
	}

	async connect(): Promise<void> {
		// No-op: headless spawns `claude` per turn; there is no shared server to start.
	}

	async disconnect(): Promise<void> {
		// Node teardown: reap every active session's spawned child process group (AC8: no orphans).
		for (const s of [...this.active]) {
			await s.close();
		}
	}

	/** Pure parse of the AICHAT_BIND binding back to (aiclawUid, roomId). Same contract as codex/opencode. */
	resolveSession(sessionKey: string): { aiclawUid: number; roomId: number } | undefined {
		return parseCcBinding(sessionKey);
	}

	/**
	 * REQ-011 S3 (§3) — reset the CC session for a room: drop the stored `session_id` so the NEXT turn
	 * spawns FRESH (no `--resume`, no prior conversation context). A first-trigger (no stored id) already
	 * spawns fresh, so this simply returns a room to that state. Minimal v1 entry point (a method; no
	 * client UX) — an `aichat` CLI subcommand can wrap it later if needed.
	 */
	resetSession(aiclawUid: number, roomId: number): void {
		this.sessionStore.delete(`aiclaw-${aiclawUid}-room-${roomId}`);
	}

	async openSession(o: {
		aiclawUid: number;
		roomId: number;
		chatContext: Record<string, unknown>;
	}): Promise<AgentSession> {
		const ctx = o.chatContext as unknown as OpencodeChatContext;
		const workspaceDir = deriveWorkspaceDir(this.workspaceBase, o.aiclawUid, ctx);
		await mkdir(workspaceDir, { recursive: true });
		const settingsPath = writeCcSettings(workspaceDir, buildCcSettings(this.brokerPort));

		const binding = `aiclaw-${o.aiclawUid}-room-${o.roomId}`;
		const session = new CcHeadlessSession({
			binding,
			roomId: o.roomId,
			// REQ-011 S3: per-turn attribution — the current sender + un-@ group-context lines, used to
			// build the per-sender-attributed stdin envelope (buildCcChannelContent). counterpartUid IS
			// the current message's fromUid (handler sets it). Defaults keep a bare ctx safe.
			roomType: typeof ctx.roomType === 'number' ? ctx.roomType : 1,
			fromName: ctx.fromName ?? 'unknown',
			fromUid: ctx.counterpartUid ?? 0,
			accumulated: ctx.accumulated ?? [],
			workspaceDir,
			settingsPath,
			claudeBin: this.claudeBin,
			sessionStore: this.sessionStore,
			registry: this.registry,
			transcript: this.transcript,
			spawn: this.spawn,
			kill: this.kill,
			firstEventTimeoutMs: this.firstEventTimeoutMs,
			drainMs: this.drainMs,
			killGraceMs: this.killGraceMs,
			onClosed: (s) => this.active.delete(s),
		});
		this.active.add(session);
		return session;
	}
}

interface CcHeadlessSessionDeps {
	binding: string;
	roomId: number;
	/** REQ-011 S3: attribution context for this turn's stdin envelope. */
	roomType: number;
	fromName: string;
	fromUid: number;
	accumulated: string[];
	workspaceDir: string;
	settingsPath: string;
	claudeBin: string;
	sessionStore: CcHeadlessSessionStore;
	registry: CcSessionRegistry;
	transcript: CcTranscriptWriter;
	spawn: CcSpawnFn;
	kill: CcKillFn;
	firstEventTimeoutMs: number;
	drainMs: number;
	killGraceMs: number;
	onClosed: (s: CcHeadlessSession) => void;
}

/**
 * One node-driven CC turn. `send()` spawns `claude` headless, writes the enriched user envelope to
 * stdin, and merges TWO async sources into one AgentEvent stream:
 *   1. stdout control-plane → captures session_id, emits `done` on `result`/EOF (after a brief drain),
 *      or `error` on failure/timeout.
 *   2. hooks (via the registry) → `thinking`/`tool` events, pushed as they arrive.
 * Mirrors the codex push→pull queue so events landing before the consumer awaits are never lost.
 */
class CcHeadlessSession implements AgentSession {
	private readonly d: CcHeadlessSessionDeps;
	private child: CcChild | null = null;
	private ended = false;

	// push→pull queue state (installed per send()).
	private buffer: AgentEvent[] = [];
	private resolveNext: (() => void) | null = null;
	private turnStart = 0;

	// completion bookkeeping
	private firstEventSeen = false;
	private turnComplete = false;
	private firstEventTimer: ReturnType<typeof setTimeout> | null = null;
	private drainTimer: ReturnType<typeof setTimeout> | null = null;
	private killTimer: ReturnType<typeof setTimeout> | null = null;
	private stdoutBuf = '';
	private stderrBuf = '';
	/** REQ-011 S3: the session_id this turn runs under (stored on resume, updated on system/init), for transcript records. */
	private sessionId: string | undefined;

	constructor(deps: CcHeadlessSessionDeps) {
		this.d = deps;
	}

	private get key(): string {
		return this.d.binding;
	}

	private wake(): void {
		if (this.resolveNext) {
			const r = this.resolveNext;
			this.resolveNext = null;
			r();
		}
	}

	private push(ev: AgentEvent): void {
		if (this.ended) return;
		this.buffer.push(ev);
		this.wake();
	}

	/** Terminal: close the queue, clear timers, deregister the room bridge, untrack from the driver. */
	private finish(): void {
		if (this.ended) return;
		this.ended = true;
		if (this.firstEventTimer) clearTimeout(this.firstEventTimer);
		if (this.drainTimer) clearTimeout(this.drainTimer);
		this.firstEventTimer = null;
		this.drainTimer = null;
		this.d.registry.deregister(this.d.roomId);
		this.d.onClosed(this);
		this.wake();
	}

	/** Turn-complete (stdout `result` / EOF backstop): drain briefly, then yield done + finish. */
	private complete(): void {
		if (this.ended || this.turnComplete) return;
		this.turnComplete = true;
		// Order the `done` AFTER any pending thinking pushes: a final Stop/MessageDisplay hook still
		// racing over loopback HTTP lands in the buffer BEFORE done during this drain window, so the
		// tail thinking is never lost (the handler stops consuming at `done`).
		this.drainTimer = setTimeout(() => {
			if (this.ended) return;
			this.push({ type: 'done', durationMs: Date.now() - this.turnStart });
			this.finish();
		}, this.d.drainMs);
	}

	/** Terminal error: emit an error event (unless the turn already completed) and finish. */
	private fail(message: string): void {
		if (this.ended || this.turnComplete) return;
		this.push({ type: 'error', message });
		this.finish();
	}

	/** Kill the child's PROCESS GROUP (detached group leader) so grandchildren (bash tools) are reaped. */
	private killChild(): void {
		const child = this.child;
		if (!child || typeof child.pid !== 'number') return;
		const pid = child.pid;
		try {
			this.d.kill(-pid, 'SIGTERM');
		} catch {
			/* already gone */
		}
		this.killTimer = setTimeout(() => {
			try {
				this.d.kill(-pid, 'SIGKILL');
			} catch {
				/* already gone */
			}
		}, this.d.killGraceMs);
		if (typeof this.killTimer === 'object' && 'unref' in this.killTimer) this.killTimer.unref();
	}

	private onFirstEvent(): void {
		if (this.firstEventSeen) return;
		this.firstEventSeen = true;
		if (this.firstEventTimer) clearTimeout(this.firstEventTimer);
		this.firstEventTimer = null;
	}

	/** Parse an NDJSON stdout line as CONTROL-PLANE ONLY (never yield thinking/text from stdout). */
	private handleStdoutLine(line: string): void {
		let raw = line.trim();
		if (raw.length === 0) return;
		// Tolerate a `data:` SSE-style prefix if present.
		if (raw.startsWith('data:')) raw = raw.slice('data:'.length).trim();
		let obj: Record<string, unknown>;
		try {
			obj = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			return; // partial / non-JSON line — ignore
		}
		this.onFirstEvent();
		const type = obj.type;
		if (type === 'system' && obj.subtype === 'init' && typeof obj.session_id === 'string' && obj.session_id) {
			this.sessionId = obj.session_id;
			this.d.sessionStore.set(this.key, { sessionId: obj.session_id });
			return;
		}
		if (type === 'result') {
			this.complete();
			return;
		}
		// REQ-011 S3 (AC9): RAW TEE of CC's output to the per-room transcript so the owner sees the full
		// session. This is NOT control-plane parsing (the panel/reply still come from hooks/the CLI) — it
		// is a passive tee for the owner, never fed back into the reply/thinking path.
		this.teeOutput(obj);
	}

	/**
	 * REQ-011 S3 (AC9): tee an `assistant` stdout event's content blocks to the transcript — assistant
	 * text / thinking as `text`, tool_use as a `tool` name. Best-effort: any shape it doesn't recognise is
	 * ignored, and it never throws (a transcript hiccup must not break the turn).
	 */
	private teeOutput(obj: Record<string, unknown>): void {
		try {
			if (obj.type !== 'assistant') return;
			const message = (obj as { message?: { content?: unknown } }).message;
			const content = message?.content;
			if (!Array.isArray(content)) return;
			for (const block of content as Array<Record<string, unknown>>) {
				const ts = Date.now();
				if (block.type === 'text' && typeof block.text === 'string') {
					this.d.transcript.append(this.d.binding, { ts, session_id: this.sessionId, kind: 'assistant', text: block.text });
				} else if (block.type === 'thinking' && typeof block.thinking === 'string') {
					this.d.transcript.append(this.d.binding, { ts, session_id: this.sessionId, kind: 'thinking', text: block.thinking });
				} else if (block.type === 'tool_use' && typeof block.name === 'string') {
					this.d.transcript.append(this.d.binding, { ts, session_id: this.sessionId, kind: 'tool_use', tool: block.name });
				}
			}
		} catch {
			/* best-effort tee — never break the turn */
		}
	}

	private handleStdoutChunk(chunk: Buffer | string): void {
		this.stdoutBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
		let nl: number;
		while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
			const line = this.stdoutBuf.slice(0, nl);
			this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
			this.handleStdoutLine(line);
		}
	}

	private buildArgv(): string[] {
		const argv = [
			'-p',
			'--input-format',
			'stream-json',
			'--output-format',
			'stream-json',
			'--verbose',
			'--include-partial-messages',
			'--allowedTools',
			'Bash(aichat:*)',
			'--settings',
			this.d.settingsPath,
			// REQ-011 S2: deliver the #102 reply contract at the SYSTEM level once per spawned turn
			// (--append-system-prompt, PR #43's proven method) — NOT prepended to each stdin user message
			// (which would pollute the content). Each headless turn is a fresh process, so it's per-turn.
			'--append-system-prompt',
			CC_REPLY_CONTRACT,
		];
		const stored = this.d.sessionStore.get(this.key);
		if (stored?.sessionId) {
			argv.push('--resume', stored.sessionId);
		}
		return argv;
	}

	private enrich(message: string): string {
		// REQ-011 S3: the #102 reply contract is delivered once per turn via `--append-system-prompt`
		// (see buildArgv), so the stdin envelope carries no per-message contract prefix — but it DOES carry
		// per-sender attribution (buildCcChannelContent), which is load-bearing for CC's anti-prompt-
		// injection defence: CC refuses bare/imperative channel text but processes a naturally-attributed
		// chat message. DM → `[HuLa 私聊]\n[name(uid)]: msg`; group → `[HuLa 群聊]\n<accumulated>\n[name(uid)]: cur`.
		return buildCcChannelContent({
			roomType: this.d.roomType,
			fromName: this.d.fromName,
			fromUid: this.d.fromUid,
			accumulated: this.d.accumulated,
			message,
		});
	}

	send(message: string): AsyncIterable<AgentEvent> {
		this.buffer = [];
		this.turnStart = Date.now();
		// REQ-011 S3: seed the session_id from the store (resume turns know it up front; a fresh turn
		// updates it when system/init arrives) so transcript records carry it.
		this.sessionId = this.d.sessionStore.get(this.key)?.sessionId;
		const attributed = this.enrich(message);
		// AC9: the INBOUND record — the attributed message the owner's CC actually received this turn.
		this.d.transcript.append(this.d.binding, {
			ts: this.turnStart,
			session_id: this.sessionId,
			kind: 'inbound',
			text: attributed,
		});

		// Register the room bridge BEFORE spawning, so a hook that fires early still routes here.
		this.d.registry.register(this.d.roomId, (ev) => this.push(ev));

		let child: CcChild;
		try {
			child = this.d.spawn(this.d.claudeBin, this.buildArgv(), {
				cwd: this.d.workspaceDir,
				env: { ...process.env, AICHAT_BIND: this.d.binding, CLAUDE_NON_INTERACTIVE: '1' },
				detached: true,
				stdio: ['pipe', 'pipe', 'pipe'],
			});
		} catch (err) {
			this.fail(err instanceof Error ? err.message : String(err));
			return this.iterable();
		}
		this.child = child;

		// First-event (stdout) watchdog.
		this.firstEventTimer = setTimeout(() => {
			if (this.ended || this.firstEventSeen) return;
			this.push({ type: 'error', message: 'first-event timeout' });
			this.killChild();
			this.finish();
		}, this.d.firstEventTimeoutMs);
		if (typeof this.firstEventTimer === 'object' && 'unref' in this.firstEventTimer) this.firstEventTimer.unref();

		child.stdout?.on('data', (c) => this.handleStdoutChunk(c));
		// EOF backstop: if the turn never emitted a `result`, EOF still completes it.
		child.stdout?.on('end', () => this.complete());
		child.stdout?.on('close', () => this.complete());
		child.stderr?.on('data', (c) => {
			this.stderrBuf += typeof c === 'string' ? c : c.toString('utf-8');
		});
		child.on('error', (err) => this.fail(err instanceof Error ? err.message : String(err)));
		child.on('exit', (code) => {
			if (this.ended || this.turnComplete) return;
			if (code === 0) {
				this.complete(); // clean exit without a parsed `result` → treat as complete
			} else {
				const tail = this.stderrBuf.trim().slice(-500);
				this.fail(`claude exited ${code}${tail ? `: ${tail}` : ''}`);
			}
		});

		// Write the stream-json user envelope, then close stdin (EOF) → claude runs one turn.
		try {
			const envelope = {
				type: 'user',
				message: { role: 'user', content: [{ type: 'text', text: attributed }] },
			};
			child.stdin?.write(`${JSON.stringify(envelope)}\n`);
			child.stdin?.end();
		} catch (err) {
			this.fail(err instanceof Error ? err.message : String(err));
		}

		return this.iterable();
	}

	private iterable(): AsyncIterable<AgentEvent> {
		const self = this;
		return {
			async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
				while (true) {
					while (self.buffer.length > 0) {
						yield self.buffer.shift()!;
					}
					if (self.ended) return;
					await new Promise<void>((resolve) => {
						self.resolveNext = resolve;
					});
				}
			},
		};
	}

	async close(): Promise<void> {
		this.killChild();
		this.finish();
	}
}
