import { mkdir } from 'node:fs/promises';
import type { Codex, Thread, ThreadOptions } from '@openai/codex-sdk';
import type { AgentDriver, AgentSession, AgentEvent } from '../events.js';
import { deriveWorkspaceDir, type OpencodeChatContext } from '../opencode/workspace.js';
import { mapCodexEvent } from './events.js';
import type { CodexSessionStore } from './session-store.js';

/**
 * The slice of the codex SDK `Codex` client this driver needs. Injecting an interface (rather than a
 * concrete `Codex`) lets tests pass a fake that scripts `startThread`/`resumeThread`.
 */
export interface CodexClient {
	startThread(opts?: ThreadOptions): Thread;
	resumeThread(id: string, opts?: ThreadOptions): Thread;
}

export interface CodexDriverDeps {
	/** The codex client (a real `Codex`, or a fake in tests). */
	codex: CodexClient;
	workspaceBase: string;
	sessionStore: CodexSessionStore;
	/** Optional model override applied to every thread (e.g. "gpt-5-codex"). */
	model?: string;
}

/** Assert at the type boundary that a real `Codex` satisfies the injected `CodexClient`. */
export type _CodexSatisfiesClient = Codex extends CodexClient ? true : never;

/**
 * REQ-010 S5 — CodexDriver: the THIRD AgentDriver (after openclaw, opencode), backed by
 * `@openai/codex-sdk`.
 *
 * Unlike opencode there is NO shared long-lived server: the SDK spawns a `codex exec` subprocess
 * per turn, so `connect()` is a no-op. Each per-(aiclawUid, roomId) conversation maps to a codex
 * Thread (created lazily on openSession, resumed across restarts via the session store), scoped to a
 * per-conversation workspace `workingDirectory`.
 *
 * THINKING-ONLY: the driver never replies to chat directly. The agent's reasoning/text and tool
 * activity stream out as AgentEvents (text = thinking); the real reply goes out-of-band via the
 * agent running `aichat send-message` in its shell. With no `terminal` event, reduceThinking
 * auto-skips — exactly correct here.
 *
 * env-injection: codex NATIVELY injects `CODEX_THREAD_ID` into its exec shell subprocess, so unlike
 * opencode (shell.env plugin) / openclaw (resolve_exec_env) NO injection hook is needed. The `aichat`
 * CLI reads `CODEX_THREAD_ID` directly; resolveSession reverse-looks-up (aiclaw, room) from the store.
 */
export class CodexDriver implements AgentDriver {
	readonly type = 'codex';

	private readonly codex: CodexClient;
	private readonly workspaceBase: string;
	private readonly sessionStore: CodexSessionStore;
	private readonly model?: string;

	constructor(deps: CodexDriverDeps) {
		this.codex = deps.codex;
		this.workspaceBase = deps.workspaceBase;
		this.sessionStore = deps.sessionStore;
		this.model = deps.model;
	}

	async connect(): Promise<void> {
		// No-op: the codex SDK spawns `codex exec` per turn; there is no shared server to start.
	}

	async disconnect(): Promise<void> {
		// No-op: no shared server / no per-driver resources. Per-turn stream cleanup is owned by
		// CodexSession.close() (called by the handler).
	}

	/**
	 * Map a codex thread id (carried by the `aichat send-message` capability as `CODEX_THREAD_ID`)
	 * back to the bound HuLa identity+room. Reverse-looks-up the `aiclaw-{uid}-room-{roomId}` key the
	 * thread id was stored under and parses it. Returns undefined when the id is unknown/unparseable.
	 */
	resolveSession(threadId: string): { aiclawUid: number; roomId: number } | undefined {
		const key = this.sessionStore.findKeyByThreadId(threadId);
		if (!key) return undefined;
		const m = /^aiclaw-(\d+)-room-(\d+)$/.exec(key);
		if (!m) return undefined;
		return { aiclawUid: Number(m[1]), roomId: Number(m[2]) };
	}

	async openSession(o: {
		aiclawUid: number;
		roomId: number;
		chatContext: Record<string, unknown>;
	}): Promise<AgentSession> {
		const ctx = o.chatContext as unknown as OpencodeChatContext;
		// Namespace the workspace by aiclawUid so two identities never collide (reuse opencode's
		// deriveWorkspaceDir — it already handles group/dm + the `~` expansion).
		const workingDirectory = deriveWorkspaceDir(this.workspaceBase, o.aiclawUid, ctx);
		await mkdir(workingDirectory, { recursive: true });

		const key = `aiclaw-${o.aiclawUid}-room-${o.roomId}`;

		// codex's default bubblewrap sandbox FAILS in the container → danger-full-access. approvalPolicy
		// "never" so the agent runs unattended; skipGitRepoCheck so a non-git workspace is fine.
		const threadOpts: ThreadOptions = {
			sandboxMode: 'danger-full-access',
			approvalPolicy: 'never',
			skipGitRepoCheck: true,
			workingDirectory,
			...(this.model ? { model: this.model } : {}),
		};

		// Lazy resume-or-create: a persisted threadId for this key → resume it; else start a new thread.
		const stored = this.sessionStore.get(key);
		const thread = stored
			? this.codex.resumeThread(stored.threadId, threadOpts)
			: this.codex.startThread(threadOpts);

		return new CodexSession(thread, key, o.aiclawUid, o.roomId, this.sessionStore);
	}
}

/**
 * One codex conversation (a Thread). `send()` runs one turn and mirrors OpencodeSession's push→pull
 * async-queue bridge: events from `thread.runStreamed()` are pushed into a buffer that the
 * async-iterator consumer pulls from, so events that land before the consumer awaits are never lost.
 */
class CodexSession implements AgentSession {
	private closed = false;
	/** Registered when send() starts; close() calls it to wake a parked consumer. */
	private closeActive: (() => void) | null = null;

	constructor(
		private readonly thread: Thread,
		private readonly key: string,
		private readonly aiclawUid: number,
		private readonly roomId: number,
		private readonly sessionStore: CodexSessionStore,
	) {}

	send(message: string): AsyncIterable<AgentEvent> {
		const buffer: AgentEvent[] = [];
		let done = false;
		let resolveNext: (() => void) | null = null;
		const turnStart = Date.now();

		// tool start/end de-dup ledger: at most one 'start' and one 'end' per command_execution item id.
		const toolStarted = new Set<string>();
		const toolEnded = new Set<string>();

		// Manual async-iterator handle on the events stream so close() can terminate a parked next().
		let streamIter: AsyncIterator<unknown> | null = null;
		let iterReturned = false;
		const returnIter = () => {
			if (iterReturned) return;
			iterReturned = true;
			try {
				void streamIter?.return?.();
			} catch {
				/* best-effort: terminate a parked iter.next() */
			}
		};

		const wake = () => {
			if (resolveNext) {
				const r = resolveNext;
				resolveNext = null;
				r();
			}
		};
		const push = (ev: AgentEvent) => {
			if (done) return;
			buffer.push(ev);
			wake();
		};
		// Error dedup invariant mirrors opencode: the FIRST push+finish wins.
		const finish = () => {
			if (done) return;
			done = true;
			returnIter();
			wake();
		};
		this.closeActive = finish;

		// Persist the captured thread.started.thread_id under BOTH directions: key→threadId (reuse on
		// the next turn / restart) and threadId→(uid,room) via findKeyByThreadId (resolveSession).
		const captureThreadStarted = (raw: unknown) => {
			const tid = (raw as { thread_id?: unknown }).thread_id;
			if (typeof tid === 'string' && tid.length > 0) {
				this.sessionStore.set(this.key, { threadId: tid });
			}
		};

		// Map a raw ThreadEvent → at most one buffered AgentEvent, applying tool de-dup and filling the
		// real durationMs on done. Returns true if the stream should end.
		const handleRaw = (raw: unknown): boolean => {
			const t = (raw as { type?: unknown }).type;
			if (t === 'thread.started') {
				captureThreadStarted(raw); // NOT an AgentEvent — capture + store, do not yield.
				return false;
			}

			const ev = mapCodexEvent(raw);
			if (!ev) return false;

			if (ev.type === 'tool') {
				const itemId = extractItemId(raw);
				const seen = ev.phase === 'start' ? toolStarted : toolEnded;
				if (itemId) {
					if (seen.has(itemId)) return false; // duplicate phase for this item → drop
					seen.add(itemId);
				}
				push(ev);
				return false;
			}
			if (ev.type === 'done') {
				push({ type: 'done', durationMs: Date.now() - turnStart });
				return true;
			}
			if (ev.type === 'error') {
				push(ev);
				return true;
			}
			// thinking
			push(ev);
			return false;
		};

		// Same role-instruction prefix as opencode-driver: the agent's text output is thinking; it
		// replies ONLY by running `aichat send-message --content "..."` in its shell. The command is
		// bound to THIS chat's room+identity automatically — never pass room/identity. No reply → run
		// nothing. Plain string prefix (no [SYSTEM] markers — filtered by gateway security hardening).
		const enrichedMessage =
			'说明：你的正文输出是分析/思考过程，不会直接发给用户。' +
			'要回复用户时，请在 bash 中运行命令 `aichat send-message --content "<你的回复>"`（参见 aichat 技能）。' +
			'当前会话已自动绑定本聊天的房间与身份，绝不要也无法传 room 或任何身份信息（由系统绑定）。' +
			'若本轮无需回复（如纯客套、无实质内容），不运行该命令即可——本轮自然结束，不会发送任何消息。\n\n' +
			'--- 用户消息如下 ---\n' +
			message;

		void (async () => {
			try {
				const { events } = await this.thread.runStreamed(enrichedMessage);
				const iter = (events as AsyncIterable<unknown>)[Symbol.asyncIterator]();
				streamIter = iter;
				if (iterReturned) {
					returnIter();
				} else {
					while (true) {
						const { value: raw, done: d } = await iter.next();
						if (d) break;
						if (done || this.closed) break;
						const end = handleRaw(raw);
						if (end) {
							finish();
							break;
						}
					}
				}
			} catch (err) {
				push({ type: 'error', message: err instanceof Error ? err.message : String(err) });
			} finally {
				finish();
			}
		})();

		const isClosed = () => this.closed;

		return {
			async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
				while (true) {
					while (buffer.length > 0) {
						yield buffer.shift()!;
					}
					if (done || isClosed()) return;
					await new Promise<void>((resolve) => {
						resolveNext = resolve;
					});
				}
			},
		};
	}

	async close(): Promise<void> {
		this.closed = true;
		if (this.closeActive) this.closeActive();
	}
}

/** Pull the codex item id out of a raw item.* ThreadEvent, for tool start/end de-dup. */
function extractItemId(raw: unknown): string | undefined {
	if (!raw || typeof raw !== 'object') return undefined;
	const item = (raw as { item?: unknown }).item as { id?: unknown } | undefined;
	return typeof item?.id === 'string' ? item.id : undefined;
}
