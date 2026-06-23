/**
 * REQ-008 #75 — Normalized agent abstraction.
 *
 * AgentEvent is the driver-agnostic event vocabulary every AgentDriver emits.
 * Concrete drivers (e.g. OpenclawDriver) translate their backend's wire/callback
 * shape into this stream; the MessageHandler consumes ONLY AgentEvents, so the
 * HuLa-side mapping logic is decoupled from any particular agent backend.
 */
export type AgentEvent =
	| { type: 'thinking'; text: string }
	| { type: 'tool'; name: string; phase: 'start' | 'end' }
	| { type: 'terminal'; action: 'sent' | 'skipped'; reason?: string }
	| { type: 'done'; durationMs: number; usage?: Record<string, unknown> }
	| { type: 'error'; message: string };

/** A single in-flight agent turn: send a message, consume the resulting event stream. */
export interface AgentSession {
	send(message: string): AsyncIterable<AgentEvent>;
	close(): Promise<void>;
}

/** A connected agent backend able to open per-(uid,room) sessions. */
export interface AgentDriver {
	readonly type: string;
	connect(): Promise<void>;
	openSession(o: { aiclawUid: number; roomId: number; chatContext: Record<string, unknown> }): Promise<AgentSession>;
	disconnect(): Promise<void>;
}
