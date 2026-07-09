import { mkdir } from 'node:fs/promises';
import type { OpencodeClient } from '@opencode-ai/sdk';
import type { AgentDriver, AgentSession, AgentEvent } from '../events.js';
import { deriveWorkspaceDir, type OpencodeChatContext } from './workspace.js';
import { mapOpencodeEvent } from './events.js';
import type { OpencodeServerManager } from './server-manager.js';
import type { SessionStore } from './session-store.js';
import { buildReplyInstruction } from '../reply-contract.js';
import { bindingKey, parseBindingKey } from '../bind-token-store.js';

/** Parsed `"providerID/modelID"` model override. */
interface ParsedModel {
	providerID: string;
	modelID: string;
}

/** Parse a `"providerID/modelID"` string; returns undefined if unset/malformed. */
function parseModel(model: string | undefined): ParsedModel | undefined {
	if (!model) return undefined;
	const slash = model.indexOf('/');
	if (slash <= 0 || slash === model.length - 1) return undefined;
	return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

export interface OpencodeDriverDeps {
	server: OpencodeServerManager;
	workspaceBase: string;
	sessionStore: SessionStore;
	/** Optional `"providerID/modelID"` model override applied to every prompt. */
	model?: string;
}

/**
 * REQ-008 #77 — OpencodeDriver: an AgentDriver backed by a shared opencode server.
 *
 * ONE OpencodeServerManager (a singleton across all opencode identities) runs a single
 * opencode server; this driver opens per-(aiclawUid, roomId) sessions against it, each
 * scoped to a per-conversation workspace `directory`. Sessions are persisted in the
 * SessionStore for cross-restart reuse.
 *
 * This slice is THINKING-ONLY: it never replies to chat. The agent's reasoning/text and
 * tool activity stream out as AgentEvents; with no `terminal` event, reduceThinking
 * auto-skips (no message is sent), which is exactly correct here.
 */
export class OpencodeDriver implements AgentDriver {
	readonly type = 'opencode';

	private readonly server: OpencodeServerManager;
	private readonly workspaceBase: string;
	private readonly sessionStore: SessionStore;
	private readonly model?: string;

	constructor(deps: OpencodeDriverDeps) {
		this.server = deps.server;
		this.workspaceBase = deps.workspaceBase;
		this.sessionStore = deps.sessionStore;
		this.model = deps.model;
	}

	async connect(): Promise<void> {
		await this.server.ensureStarted();
	}

	/**
	 * REQ-010 S1: map an opencode session id (carried by the `aichat send-message` capability as
	 * its sessionKey) back to the bound HuLa identity+room. Looks up the key this session id was
	 * stored under (`aiclaw-{uid}-room-{roomId}`) and parses it. Returns undefined if the id is
	 * unknown or the key is unparseable.
	 *
	 * ponytail: this scans THIS driver's in-memory sessionStore. Correct for the PoC's single
	 * opencode identity. Multiple opencode identities share the sessions.json file on disk but
	 * have SEPARATE in-memory maps, so a fresh session created by another identity after this
	 * driver loaded won't resolve here until reload. Upgrade when N>1: a shared session index or a
	 * per-call reload of the store.
	 */
	resolveSession(sessionKey: string): { aiclawUid: string; roomId: string } | undefined {
		const key = this.sessionStore.findKeyBySessionID(sessionKey);
		return key ? parseBindingKey(key) : undefined;
	}

	/**
	 * aichatoverview#124 — drop the stored session for this (uid,room) so the NEXT turn creates a FRESH
	 * opencode session (context cleared). Key built FROM THE ARGS. Returns true (this driver is stateful).
	 */
	resetSession(aiclawUid: string, roomId: string): boolean {
		this.sessionStore.delete(bindingKey(aiclawUid, roomId));
		return true;
	}

	async disconnect(): Promise<void> {
		// No-op. The shared opencode server is NOT owned by any single driver — it is a
		// singleton serving N opencode identities, so stopping it here would kill ALL of
		// them and break the supervisor's per-agent isolation. It is closed only by GLOBAL
		// shutdown (see start.ts startMultiIdentity). This driver has no other per-driver
		// resources to release: per-turn SSE subscriptions are owned by OpencodeSession and
		// closed via AgentSession.close() by the handler.
	}

	// ponytail/TODO(#78): shared-server fault-domain recovery — if the singleton server
	// crashes, the sessionIDs persisted here become stale. A future slice should detect a
	// crashed server and lazily rebuild the session on the next openSession/send. Not done
	// now: no crash detection / retry here.
	async openSession(o: {
		aiclawUid: string;
		roomId: string;
		chatContext: Record<string, unknown>;
	}): Promise<AgentSession> {
		const ctx = o.chatContext as unknown as OpencodeChatContext;
		// REQ-008 #77 fix: namespace the workspace by aiclawUid so two identities never collide.
		const directory = deriveWorkspaceDir(this.workspaceBase, o.aiclawUid, ctx);
		await mkdir(directory, { recursive: true });

		const key = bindingKey(o.aiclawUid, o.roomId);
		const client = this.server.getClient();

		// Lazy create-or-reuse: a persisted binding for the SAME directory is reusable.
		// (A binding for a different directory is stale — recreate so the session is scoped
		// to the current workspace.)
		const stored = this.sessionStore.get(key);
		let sessionID: string;
		if (stored && stored.directory === directory) {
			sessionID = stored.sessionID;
		} else {
			const created = await client.session.create({ query: { directory }, body: { title: key } });
			const id = (created as { data?: { id?: string } }).data?.id;
			if (!id) throw new Error('opencode session.create returned no session id');
			sessionID = id;
			this.sessionStore.set(key, { sessionID, directory });
		}

		// REQ-008 #78 P2③ lazy rebuild: if send() fails because the server/session is gone,
		// drop the stored binding so the NEXT openSession recreates the session, and best-effort
		// restart the shared server. Lazy rebuild = recover on the next turn, not same-turn retry.
		// TODO(#78): fuller crash detection / auto-retry (probe + same-turn re-prompt) is a future
		// refinement; for now we only invalidate so we don't keep prompting a dead session.
		const onSessionError = () => {
			this.sessionStore.delete(key);
			void this.server.restart().catch(() => {
				/* best-effort: the next openSession's getClient()/ensureStarted() recovers */
			});
		};

		return new OpencodeSession(client, sessionID, directory, parseModel(this.model), onSessionError);
	}
}

/**
 * One in-flight opencode turn. Mirrors openclaw-driver.ts's push→pull async-queue bridge:
 * SSE events fired by the subscription are pushed into a buffer that the async-iterator
 * consumer pulls from, so events that land before the consumer awaits are never lost.
 *
 * Ordering guarantee: subscribe FIRST, then prompt — so no event between prompt-accepted
 * and the first poll is missed.
 */
class OpencodeSession implements AgentSession {
	private closed = false;
	/** Registered when send() starts; close() calls it to wake a parked consumer. */
	private closeActive: (() => void) | null = null;

	constructor(
		private readonly client: OpencodeClient,
		private readonly sessionID: string,
		private readonly directory: string,
		private readonly model: ParsedModel | undefined,
		/**
		 * REQ-008 #78 P2③: invoked once when send()'s subscribe/prompt throws (server/session
		 * gone), AFTER the terminal error has been emitted. The driver wires this to drop the
		 * stale session binding (lazy rebuild on the next turn) + best-effort restart the server.
		 */
		private readonly onSessionError?: () => void,
	) {}

	send(message: string): AsyncIterable<AgentEvent> {
		const buffer: AgentEvent[] = [];
		let done = false;
		let resolveNext: (() => void) | null = null;
		const turnStart = Date.now();

		// tool start/end de-dup ledger: at most one 'start' and one 'end' per callID.
		// mapOpencodeEvent is stateless per-event; we collapse repeats here.
		const toolStarted = new Set<string>();
		const toolEnded = new Set<string>();

		// Manual async-iterator handle on the SSE stream so we can close it externally even
		// while a consumer is PARKED on iter.next() (a `for await` can't be interrupted).
		let streamIter: AsyncIterator<unknown> | null = null;
		let iterReturned = false;
		const returnIter = () => {
			if (iterReturned) return; // call return() at most once
			iterReturned = true;
			try {
				void streamIter?.return?.();
			} catch {
				/* best-effort: terminate a parked iter.next() / close the subscription */
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
		// Error dedup invariant: the FIRST push+finish wins. Because push() is a no-op once
		// `done` is set and finish() runs synchronously right after the first error push
		// (prompt-rejection path) or right after handleRaw returns true (SSE-error path),
		// a second error can never be buffered — at most ONE 'error' event reaches the
		// consumer. finish() also closes the SSE iterator so a parked turn ends promptly.
		const finish = () => {
			if (done) return;
			done = true;
			returnIter();
			wake();
		};
		this.closeActive = finish;

		// Map a raw SSE event → at most one buffered AgentEvent, applying tool de-dup and
		// filling the real durationMs on done. Returns true if the stream should end.
		const handleRaw = (raw: unknown): boolean => {
			const ev = mapOpencodeEvent(raw, this.sessionID);
			if (!ev) return false;

			if (ev.type === 'tool') {
				const callID = extractCallID(raw);
				const seen = ev.phase === 'start' ? toolStarted : toolEnded;
				if (callID) {
					if (seen.has(callID)) return false; // duplicate phase for this callID → drop
					seen.add(callID);
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

		// REQ-010 S1: prepend the shared role-instruction (agent/reply-contract.ts): text output is thinking,
		// reply ONLY via `aichat send-message` in bash, room/identity auto-bound, no reply -> run nothing.
		const enrichedMessage = buildReplyInstruction(message);

		// Drive the SDK: subscribe first (avoid the race), then prompt, then pump events.
		void (async () => {
			try {
				const { stream } = await this.client.event.subscribe({ query: { directory: this.directory } });

				// Fire the prompt AFTER subscribing so no early event is missed. We do not await
				// its completion to drive the loop — completion arrives via session.idle.
				const promptPromise = this.client.session.prompt({
					path: { id: this.sessionID },
					query: { directory: this.directory },
					body: {
						parts: [{ type: 'text', text: enrichedMessage }],
						...(this.model ? { model: this.model } : {}),
					},
				});
				// Surface a prompt rejection as a terminal error event. push()+finish() are
				// sequential with no await between them, so once finish() sets `done`, any
				// later error push (e.g. an SSE session.error) is dropped — single error.
				promptPromise.then(
					() => {},
					(err: unknown) => {
						push({ type: 'error', message: err instanceof Error ? err.message : String(err) });
						finish();
						// P2③: prompt rejected (session/server gone) → invalidate for lazy rebuild.
						this.onSessionError?.();
					},
				);

				// Iterate the stream MANUALLY (not `for await`) so finish()/close() can call
				// streamIter.return() to terminate a parked next() and close the subscription.
				const iter = stream[Symbol.asyncIterator]();
				streamIter = iter;
				if (iterReturned) {
					// finish()/close() already fired before we stored the iterator → honor it.
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
				// P2③: subscribe (or other setup) threw → invalidate for lazy rebuild on next turn.
				this.onSessionError?.();
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
		// Wake a consumer parked on the await inside the iterator (mirror openclaw-driver).
		if (this.closeActive) this.closeActive();
	}
}

/** Pull the tool callID out of a message.part.updated raw event, for de-dup. */
function extractCallID(raw: unknown): string | undefined {
	if (!raw || typeof raw !== 'object') return undefined;
	const props = (raw as { properties?: unknown }).properties as { part?: unknown } | undefined;
	const part = props?.part as { callID?: unknown } | undefined;
	return typeof part?.callID === 'string' ? part.callID : undefined;
}
