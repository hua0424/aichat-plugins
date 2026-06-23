import { mkdir } from 'node:fs/promises';
import type { OpencodeClient } from '@opencode-ai/sdk';
import type { AgentDriver, AgentSession, AgentEvent } from '../events.js';
import { deriveWorkspaceDir, type OpencodeChatContext } from './workspace.js';
import { mapOpencodeEvent } from './events.js';
import type { OpencodeServerManager } from './server-manager.js';
import type { SessionStore } from './session-store.js';

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

	async disconnect(): Promise<void> {
		await this.server.stop();
	}

	async openSession(o: {
		aiclawUid: number;
		roomId: number;
		chatContext: Record<string, unknown>;
	}): Promise<AgentSession> {
		const ctx = o.chatContext as unknown as OpencodeChatContext;
		const directory = deriveWorkspaceDir(this.workspaceBase, ctx);
		await mkdir(directory, { recursive: true });

		const key = `aiclaw-${o.aiclawUid}-room-${o.roomId}`;
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

		return new OpencodeSession(client, sessionID, directory, parseModel(this.model));
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
		const finish = () => {
			if (done) return;
			done = true;
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
						parts: [{ type: 'text', text: message }],
						...(this.model ? { model: this.model } : {}),
					},
				});
				// Surface a prompt rejection as a terminal error event.
				promptPromise.then(
					() => {},
					(err: unknown) => {
						push({ type: 'error', message: err instanceof Error ? err.message : String(err) });
						finish();
					},
				);

				for await (const raw of stream) {
					if (done || this.closed) break;
					const end = handleRaw(raw);
					if (end) {
						finish();
						break;
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
