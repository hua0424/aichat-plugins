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
	/**
	 * `chatContext` is a generic per-turn bag (a driver reads only the keys it cares about): the
	 * REQ-008/#85 workspace keys (roomType/roomId/counterpartUid/isOwner/workspaceDir/account) plus
	 * #132's `selfName` (this aiclaw's own display name, threaded in cc-only for identity anchoring).
	 * Per-sender attribution is NOT carried here — it's assembled at the handler layer into the unified
	 * inbound envelope (REQ-013 S1, ./handler/envelope.ts) before the message reaches the driver.
	 */
	openSession(o: { aiclawUid: string; roomId: string; chatContext: Record<string, unknown> }): Promise<AgentSession>;
	disconnect(): Promise<void>;
	/**
	 * REQ-010 S1: resolve an agent-session-scoped key back to the bound HuLa identity+room.
	 * Used by the loopback capability endpoint to look up where an `aichat send-message`
	 * call (which carries only the agent's session id, never room/identity) should land.
	 * Optional: drivers that don't back the capability path (e.g. OpenclawDriver) need not
	 * implement it. Returns undefined when the key is unknown/unparseable.
	 */
	resolveSession?(sessionKey: string): { aiclawUid: string; roomId: string } | undefined;
	/**
	 * Runtime per-room session reset (aichatoverview#124): drop any stored per-(uid,room) session state
	 * so the NEXT inbound message opens a FRESH session (context cleared). Other rooms are unaffected.
	 * Returns true if this driver maintains per-room session state (state was dropped); false if the
	 * driver is stateless per-room (no store → no-op, e.g. openclaw whose binding IS the session).
	 */
	resetSession?(aiclawUid: string, roomId: string): boolean;
}
