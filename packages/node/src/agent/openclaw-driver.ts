import type { AgentDriver, AgentSession, AgentEvent } from './events.js';
import type { ClawAdapter, ThinkingCallbacks } from '../claw/interface.js';

/**
 * REQ-008 #75 — OpenclawDriver: the first AgentDriver, a thin WRAPPER around the
 * unchanged OpenclawAdapter WS engine. It bridges the adapter's push-style
 * ThinkingCallbacks into the pull-style AgentEvent async stream; it does NOT
 * reimplement any handshake / reconnect / event-routing logic.
 */
export class OpenclawDriver implements AgentDriver {
	readonly type = 'openclaw';

	constructor(private readonly adapter: ClawAdapter) {}

	async connect(): Promise<void> {
		await this.adapter.connect();
	}

	async disconnect(): Promise<void> {
		await this.adapter.disconnect();
	}

	async openSession(o: {
		aiclawUid: number;
		roomId: number;
		chatContext: Record<string, unknown>;
	}): Promise<AgentSession> {
		const sessionKey = `aiclaw-${o.aiclawUid}-room-${o.roomId}`;
		return new OpenclawSession(this.adapter, sessionKey, o.roomId);
	}
}

/**
 * One in-flight agent turn over the OpenclawAdapter (single-flight for this slice).
 * send() returns an async iterable backed by a minimal push→pull queue so events
 * fired by the adapter's callbacks (possibly synchronously, before the consumer
 * awaits) are buffered and never lost.
 */
class OpenclawSession implements AgentSession {
	private closed = false;

	constructor(
		private readonly adapter: ClawAdapter,
		private readonly sessionKey: string,
		private readonly roomId: number,
	) {}

	send(message: string): AsyncIterable<AgentEvent> {
		const buffer: AgentEvent[] = [];
		let done = false;
		let resolveNext: (() => void) | null = null;

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

		const callbacks: ThinkingCallbacks = {
			onThinkingDelta: (text) => push({ type: 'thinking', text }),
			onTerminalTool: (info) => push({ type: 'terminal', action: info.action, reason: info.reason }),
			onThinkingEnd: (durationMs) => {
				push({ type: 'done', durationMs });
				finish();
			},
			onError: (err) => {
				push({ type: 'error', message: err.message });
				finish();
			},
		};

		// Fire the adapter chat. Errors from the call itself surface as an error event.
		this.adapter.chat(message, this.sessionKey, callbacks, { roomId: this.roomId }).catch((err) => {
			push({ type: 'error', message: err instanceof Error ? err.message : String(err) });
			finish();
		});

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
	}
}
