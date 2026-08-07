import { mkdir } from 'node:fs/promises';
import { spawn as nodeSpawn } from 'node:child_process';
import type { AgentDriver, AgentSession, AgentEvent } from '../events.js';
import { deriveWorkspaceDir, type ChatContext } from '../workspace.js';
import { buildCcSettings, writeCcSettings } from './launch.js';
import { buildSystemPrompt } from '../prompt-templates.js';
import type { CcHeadlessSessionStore } from './headless-session-store.js';
import type { CcSessionRegistry } from './sink.js';
import { FileCcTranscriptWriter, type CcTranscriptWriter } from './transcript.js';
import { bindingKey, type BindTokenStore } from '../bind-token-store.js';
import { errMsg } from '../../util/err.js';

/**
 * REQ-011 S2 — CcHeadlessDriver: claude-code as the FOURTH node-driven AgentDriver (after openclaw,
 * opencode, codex). The channel approach was abandoned; CC now runs HEADLESS, spawned per inbound turn.
 *
 * A deliberate HYBRID: node drives the turn (like the other three), but the reply exit is UNCHANGED
 * from the owner-driven model:
 *   - REPLY    = CC itself runs `aichat send-message` (the #102 capability CLI, out-of-band). NOT parsed
 *                from stdout.
 *   - THINKING = sourced from the STDOUT TEE (`teeOutput`): each assistant `text`/`thinking` content
 *                block — the same data that populates the per-room transcript — is pushed as a
 *                `{thinking}` AgentEvent into THIS session's stream, so the handler's standard
 *                reduceThinking path renders the panel. This is DISPLAY ONLY; it never becomes the reply.
 *                (#120) The original design sourced THINKING from CC's HOOKS (MessageDisplay → broker →
 *                panel), but that path never delivered content: claude-code's MessageDisplay hook carries
 *                the assistant text in a `delta` field, not `content`, so the broker's `content` read was
 *                always empty and the CC panel stayed blank. That hooks→panel path is removed.
 *   - STDOUT   = capture `session_id` (system/init), detect turn-complete (`result` event / EOF),
 *                first-event timeout, errors — AND tee assistant `text`/`thinking` blocks to the panel +
 *                transcript (display only). The reply is NEVER parsed from stdout (it would conflict with
 *                the CLI reply); tool activity stays on the PostToolUse hook path.
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
	/**
	 * BL-014 (#141): opaque agent-facing binding token store. The value injected into CC's `AICHAT_BIND`
	 * env is a node-minted token (not the plaintext `aiclaw-{uid}-room-{roomId}` binding), so an agent
	 * that overwrites AICHAT_BIND cannot forge another (uid,room). resolveSession looks the token up here.
	 */
	bindTokens: BindTokenStore;
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
/** Cap on the serialized tool_use input captured into the transcript (truncated past this). */
const MAX_TOOL_INPUT_CHARS = 2000;

export class CcHeadlessDriver implements AgentDriver {
	readonly type = 'cc';

	private readonly claudeBin: string;
	private readonly workspaceBase: string;
	private readonly brokerPort: number;
	private readonly sessionStore: CcHeadlessSessionStore;
	private readonly bindTokens: BindTokenStore;
	private readonly registry: CcSessionRegistry;
	private readonly transcript: CcTranscriptWriter;
	private readonly spawn: CcSpawnFn;
	private readonly kill: CcKillFn;
	private readonly firstEventTimeoutMs: number;
	private readonly drainMs: number;
	private readonly killGraceMs: number;

	/** Active sessions, so node teardown (disconnect) reaps every spawned child's process group. */
	private readonly active = new Set<CcHeadlessSession>();

	/**
	 * aichatoverview#166: settings.json content is `brokerPort`-only (a process constant), yet it was
	 * re-written every turn. Memoize workspaceDir → its settings path so each dir is written ONCE per
	 * process (later turns in that dir reuse the path, no disk write).
	 */
	private readonly settingsPathByDir = new Map<string, string>();

	constructor(deps: CcHeadlessDriverDeps) {
		this.claudeBin = deps.claudeBin ?? 'claude';
		this.workspaceBase = deps.workspaceBase;
		this.brokerPort = deps.brokerPort;
		this.sessionStore = deps.sessionStore;
		this.bindTokens = deps.bindTokens;
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

	/**
	 * BL-014 (#141): resolve the opaque AICHAT_BIND token back to (aiclawUid, roomId) via the store.
	 * No longer a parse of the plaintext binding (which an agent could forge by overwriting AICHAT_BIND) —
	 * a forged plaintext binding is not a minted token → undefined → the capability endpoint 404s.
	 */
	resolveSession(sessionKey: string): { aiclawUid: string; roomId: string } | undefined {
		return this.bindTokens.resolve(sessionKey);
	}

	/**
	 * REQ-011 S3 (§3) — reset the CC session for a room: drop the stored `session_id` so the NEXT turn
	 * spawns FRESH (no `--resume`, no prior conversation context). A first-trigger (no stored id) already
	 * spawns fresh, so this simply returns a room to that state. Minimal v1 entry point (a method; no
	 * client UX) — an `aichat` CLI subcommand can wrap it later if needed.
	 */
	resetSession(aiclawUid: string, roomId: string): boolean {
		this.sessionStore.delete(bindingKey(aiclawUid, roomId));
		return true;
	}

	async openSession(o: {
		aiclawUid: string;
		roomId: string;
		chatContext: ChatContext;
	}): Promise<AgentSession> {
		const ctx = o.chatContext;
		const workspaceDir = deriveWorkspaceDir(this.workspaceBase, o.aiclawUid, ctx);
		await mkdir(workspaceDir, { recursive: true });
		// #166: write settings.json once per workspaceDir (content is the process-constant brokerPort).
		let settingsPath = this.settingsPathByDir.get(workspaceDir);
		if (settingsPath === undefined) {
			settingsPath = writeCcSettings(workspaceDir, buildCcSettings(this.brokerPort));
			this.settingsPathByDir.set(workspaceDir, settingsPath);
		}

		// REQ-018: render the unified system prompt once per (per-turn) session from the handler-supplied
		// templates + persona + resolved display name. The display name of THIS aiclaw is resolved LAZILY
		// via chatContext.getSelfName (now shared by all four drivers; a driver calls it only when templates
		// are present). Optional — an unresolved name still anchors the uid in the system prompt.
		const selfName = ctx.templates ? await ctx.getSelfName?.() : undefined;
		const systemPrompt = ctx.templates
			? buildSystemPrompt(ctx.templates, { displayName: selfName, uid: o.aiclawUid, persona: ctx.persona ?? null })
			: undefined;
		// KEEP the plaintext binding for ALL node-internal keying (session_id store, transcript, registry,
		// resetSession) — it never leaves the node. BL-014 (#141): mint a STABLE opaque token for the ONLY
		// agent-facing value (the spawn's AICHAT_BIND env), so a bash-capable agent can't forge (uid,room).
		const binding = bindingKey(o.aiclawUid, o.roomId);
		const bindToken = this.bindTokens.mint(o.aiclawUid, o.roomId);
		const session = new CcHeadlessSession({
			binding,
			bindToken,
			roomId: o.roomId,
			workspaceDir,
			settingsPath,
			claudeBin: this.claudeBin,
			aiclawUid: o.aiclawUid,
			systemPrompt,
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
	/**
	 * BL-014 (#141): the opaque token to inject as the spawn's `AICHAT_BIND` env — the ONLY agent-facing
	 * binding value. Everything else (session_id store, transcript, registry keys) uses `binding`.
	 */
	bindToken: string;
	roomId: string;
	workspaceDir: string;
	settingsPath: string;
	claudeBin: string;
	/** this aiclaw's own uid, pinned into the cc system-prompt identity anchor (REQ-018). */
	aiclawUid: string;
	/**
	 * REQ-018: the fully-rendered unified system prompt (identity anchor + persona + reply contract),
	 * delivered via `claude --append-system-prompt`. Optional — a turn without templates has none
	 * (argv simply omits the flag; the stdin envelope is the pure attributed text).
	 */
	systemPrompt?: string;
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
 * One node-driven CC turn. `send()` spawns `claude` headless, writes the given user envelope (already
 * the unified attribution transcript, built at the handler common layer) to stdin, and merges TWO async
 * sources into one AgentEvent stream:
 *   1. stdout → captures session_id, emits `done` on `result`/EOF (after a brief drain) or `error` on
 *      failure/timeout, AND tees each assistant `text`/`thinking` block as a `{thinking}` event for the
 *      panel (#120, display only — the reply is out-of-band via the CLI).
 *   2. hooks (via the registry) → `{tool}` events (PostToolUse), pushed as they arrive.
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

	// REQ-011 S5 (#112): --resume self-heal bookkeeping.
	/** Per-attempt token: every async handler early-returns unless it still matches, so a killed
	 * resume-child's late events cannot disturb the fresh retry attempt (stale-child guard). */
	private attemptSeq = 0;
	/** Whether THIS attempt spawned with `--resume` (a stored session_id existed at spawn time). */
	private attemptUsedResume = false;
	/** One-shot: a dead-`--resume` failure self-heals ONCE (clear id + fresh retry); a second failure is real. */
	private retriedFresh = false;
	/** The attributed stdin envelope for THIS turn — set once in send() before any handler can fire, so
	 * a failure detected in handleStdoutLine (which has no `attributed` in scope) can self-heal/re-spawn. */
	private attributed = '';

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
		// Order the `done` AFTER any pending pushes: a final Stop/PostToolUse hook still racing over
		// loopback HTTP lands in the buffer BEFORE done during this drain window, so tail tool activity
		// is never lost (the handler stops consuming at `done`).
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
			// A dead `--resume` (session gone after `~/.claude` was wiped) does NOT just exit non-zero —
			// real `claude` FIRST emits an ERROR `result` on stdout, then exits 1. Routing ANY result to
			// complete() would set turnComplete → the later non-zero exit bails on its guard → self-heal
			// never fires. So an error result routes to the FAILURE path (self-heal on --resume, {error}
			// on a fresh attempt); only a normal success result completes.
			if (obj.is_error === true || obj.subtype === 'error_during_execution') {
				const errs = obj.errors;
				const detail = Array.isArray(errs) && errs.length > 0 ? errs.join('; ') : (typeof obj.subtype === 'string' ? obj.subtype : 'unknown');
				this.onAttemptFailure(`claude result error: ${detail}`);
				return;
			}
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
	 *
	 * (#120) The `text`/`thinking` blocks ALSO feed the thinking PANEL: each is pushed as a `{thinking}`
	 * AgentEvent so reduceThinking concatenates it into the THINKING_END content (the panel now shows the
	 * same text as the transcript). This is DISPLAY ONLY — the reply is out-of-band via the agent running
	 * `aichat send-message` (the CLI capability); no reply is ever extracted from stdout. `tool_use` blocks
	 * push NO thinking event (tool activity stays on the PostToolUse hook path).
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
					// #120: tee assistant narration to the thinking panel for DISPLAY only; the reply is
					// sent out-of-band via the agent's `aichat send-message` CLI, never parsed from stdout.
					this.push({ type: 'thinking', text: block.text });
				} else if (block.type === 'thinking' && typeof block.thinking === 'string') {
					this.d.transcript.append(this.d.binding, { ts, session_id: this.sessionId, kind: 'thinking', text: block.thinking });
					// #120: tee extended reasoning to the thinking panel for DISPLAY only (see above).
					this.push({ type: 'thinking', text: block.thinking });
				} else if (block.type === 'tool_use' && typeof block.name === 'string') {
					// Capture the FULL tool input as JSON (truncated past the cap) so the transcript shows what
					// the tool was actually called with, not just its name. Only when an input is present.
					let toolInput: string | undefined;
					if (block.input !== undefined) {
						const json = JSON.stringify(block.input);
						toolInput =
							json.length > MAX_TOOL_INPUT_CHARS
								? `${json.slice(0, MAX_TOOL_INPUT_CHARS)}…[truncated ${json.length - MAX_TOOL_INPUT_CHARS} chars]`
								: json;
					}
					this.d.transcript.append(this.d.binding, {
						ts,
						session_id: this.sessionId,
						kind: 'tool_use',
						tool: block.name,
						...(toolInput !== undefined ? { tool_input: toolInput } : {}),
					});
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
		];
		// REQ-018: deliver the unified system prompt at the SYSTEM level once per spawned turn
		// (--append-system-prompt, PR #43's proven method) — rendered from server-fetched templates
		// (identity anchor + persona + reply contract). NOT prepended to each stdin user message (which
		// would pollute the content). Each headless turn is a fresh process, so it's per-turn. A turn
		// without templates simply omits the flag (no system layer → degrade gracefully).
		if (this.d.systemPrompt) {
			argv.push('--append-system-prompt', this.d.systemPrompt);
		}
		const stored = this.d.sessionStore.get(this.key);
		if (stored?.sessionId) {
			argv.push('--resume', stored.sessionId);
		}
		return argv;
	}

	send(message: string): AsyncIterable<AgentEvent> {
		this.buffer = [];
		this.turnStart = Date.now();
		// REQ-011 S3: seed the session_id from the store (resume turns know it up front; a fresh turn
		// updates it when system/init arrives) so transcript records carry it.
		this.sessionId = this.d.sessionStore.get(this.key)?.sessionId;
		// REQ-013 S1: the message is already the full unified attribution envelope (built at the handler's
		// common layer, see handler/envelope.ts) — the driver forwards it verbatim into the stdin envelope,
		// the transcript `inbound` record, and any self-heal re-send.
		const attributed = message;
		// Set BEFORE spawning so any handler (incl. handleStdoutLine, which has no `attributed` in scope)
		// can self-heal/re-spawn via onAttemptFailure(). One value per turn (a self-heal retry re-sends it).
		this.attributed = attributed;
		// AC9: the INBOUND record — the attributed message the owner's CC actually received this turn.
		// Appended ONCE per turn (not per attempt): a self-heal retry is the SAME inbound message.
		this.d.transcript.append(this.d.binding, {
			ts: this.turnStart,
			session_id: this.sessionId,
			kind: 'inbound',
			text: attributed,
		});

		// Register the room bridge BEFORE spawning, so a hook that fires early still routes here.
		this.d.registry.register(this.d.roomId, (ev) => this.push(ev));

		this.spawnAttempt(attributed);
		return this.iterable();
	}

	/**
	 * REQ-011 S5 (#112): one spawn attempt of the turn. Extracted from send() so the turn can retry FRESH
	 * (self-heal) after a dead `--resume`. Builds argv, spawns, installs the first-event watchdog + the
	 * stale-child-guarded stdout/stderr/error/exit handlers, and writes the stdin envelope. Per-attempt
	 * state (firstEventSeen, buffers, watchdog) is reset here; turn-spanning state (queue, turnStart,
	 * turnComplete, ended) is preserved so a retry continues the SAME turn.
	 */
	private spawnAttempt(attributed: string): void {
		// Stale-child guard token: bumped each attempt so a killed resume-child's late events are dropped.
		const myAttempt = ++this.attemptSeq;
		// Reset per-attempt state (the turn-spanning queue/turnStart/turnComplete/ended are left as-is).
		this.firstEventSeen = false;
		this.stdoutBuf = '';
		this.stderrBuf = '';
		if (this.firstEventTimer) clearTimeout(this.firstEventTimer);
		this.firstEventTimer = null;

		// buildArgv() appends `--resume` iff a session_id is stored; capture whether THIS attempt used it,
		// so a failure with `--resume` self-heals (clear + fresh retry) while a fresh failure is real.
		this.attemptUsedResume = !!this.d.sessionStore.get(this.key)?.sessionId;

		let child: CcChild;
		try {
			child = this.d.spawn(this.d.claudeBin, this.buildArgv(), {
				cwd: this.d.workspaceDir,
				// BL-014 (#141): AICHAT_BIND carries the OPAQUE token, never the plaintext binding — the CC
				// hook broker reads it as its `Authorization: Bearer <token>` and the reply CLI emits `cc:<token>`.
				env: { ...process.env, AICHAT_BIND: this.d.bindToken, CLAUDE_NON_INTERACTIVE: '1' },
				detached: true,
				stdio: ['pipe', 'pipe', 'pipe'],
			});
		} catch (err) {
			this.onAttemptFailure(errMsg(err));
			return;
		}
		this.child = child;

		// First-event (stdout) watchdog. A hung attempt kills its group and self-heals (may be a dead resume).
		this.firstEventTimer = setTimeout(() => {
			if (myAttempt !== this.attemptSeq) return;
			if (this.ended || this.firstEventSeen) return;
			this.killChild();
			this.onAttemptFailure('first-event timeout');
		}, this.d.firstEventTimeoutMs);
		if (typeof this.firstEventTimer === 'object' && 'unref' in this.firstEventTimer) this.firstEventTimer.unref();

		child.stdout?.on('data', (c) => {
			if (myAttempt !== this.attemptSeq) return;
			this.handleStdoutChunk(c);
		});
		// EOF backstop: if the turn never emitted a `result`, EOF still completes it.
		child.stdout?.on('end', () => {
			if (myAttempt !== this.attemptSeq) return;
			this.complete();
		});
		child.stdout?.on('close', () => {
			if (myAttempt !== this.attemptSeq) return;
			this.complete();
		});
		child.stderr?.on('data', (c) => {
			if (myAttempt !== this.attemptSeq) return;
			this.stderrBuf += typeof c === 'string' ? c : c.toString('utf-8');
		});
		child.on('error', (err) => {
			if (myAttempt !== this.attemptSeq) return;
			this.onAttemptFailure(errMsg(err));
		});
		child.on('exit', (code) => {
			if (myAttempt !== this.attemptSeq) return;
			if (this.ended || this.turnComplete) return;
			if (code === 0) {
				this.complete(); // clean exit without a parsed `result` → treat as complete
			} else {
				const tail = this.stderrBuf.trim().slice(-500);
				this.onAttemptFailure(`claude exited ${code}${tail ? `: ${tail}` : ''}`);
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
			this.onAttemptFailure(errMsg(err));
		}
	}

	/**
	 * REQ-011 S5 (#112): route EVERY per-attempt failure (spawn throw, child `error`, non-zero exit,
	 * first-event timeout) here. If this attempt used `--resume` and we have not yet retried, the stored
	 * session_id is probably DEAD (e.g. `~/.claude` reverted after a container redeploy) → clear it and
	 * retry the SAME turn ONCE with a fresh session (buildArgv now omits `--resume`). A fresh attempt (or
	 * an already-retried turn) that fails is a genuine error — emit it (no further retry → no infinite loop).
	 * Per #112 we do NOT distinguish "session-not-found" from a transient error: a false-positive clear
	 * costs at most this one turn's context (the fresh retry), which is acceptable.
	 */
	private onAttemptFailure(message: string): void {
		if (this.ended || this.turnComplete) return;
		if (this.attemptUsedResume && !this.retriedFresh) {
			this.retriedFresh = true;
			this.d.sessionStore.delete(this.key); // clear the dead session_id → fresh retry
			this.sessionId = undefined;
			this.killChild(); // reap the failed resume-child's process group
			this.child = null;
			this.spawnAttempt(this.attributed); // buildArgv now omits --resume → fresh retry (same turn)
			return;
		}
		this.fail(message); // fresh attempt (or already retried) failed → real error
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
