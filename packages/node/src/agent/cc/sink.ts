import type { AgentEvent } from '../events.js';
import type { CcHookSink } from './broker.js';

/**
 * REQ-011 S2 — the CcBroker sink reworked into a per-room session-stream BRIDGE.
 *
 * CC is now node-driven (CcHeadlessDriver): the standard MessageHandler path opens a CcHeadlessSession
 * whose `send()` emits an AgentEvent stream. The reply and turn-completion come from that session
 * (`aichat send-message` CLI + stdout control-plane), but the THINKING/tool activity is sourced from
 * CC's **hooks**, which POST to the CcBroker. This registry is how a hook (resolved to a room) reaches
 * the active session's event queue:
 *
 *   CC hook → CcBroker.handle → CcHookSink (buildCcBridgeSink) → CcSessionRegistry.push(roomId, ev)
 *          → the active CcHeadlessSession's push → its send() AsyncIterable → the handler's standard path
 *
 * A hook for a room with NO active session (late/racing hook, or a room whose turn already finished) is
 * a safe no-op drop — never a throw.
 */

/** The event-injection function a live CcHeadlessSession registers for its room. */
export type CcEventPush = (ev: AgentEvent) => void;

/**
 * Per-room registry of the currently-active CcHeadlessSession's push. One node serves one uid, so the
 * roomId is a unique key within the node. `register`/`deregister` are called by the session on send
 * start / finish; `push` is called by the bridge sink as hooks arrive.
 */
export class CcSessionRegistry {
	// REQ-029 (#29): roomId key is an opaque string (>2^53-safe).
	private readonly byRoom = new Map<string, CcEventPush>();

	register(roomId: string, push: CcEventPush): void {
		this.byRoom.set(roomId, push);
	}

	deregister(roomId: string): void {
		this.byRoom.delete(roomId);
	}

	/** Route an AgentEvent to the room's active session, or a safe no-op if none is registered. */
	push(roomId: string, ev: AgentEvent): void {
		this.byRoom.get(roomId)?.(ev);
	}
}

/**
 * Build the CcHookSink that bridges resolved CC hooks into the per-room session stream:
 *   - PostToolUse  → a `{tool}` AgentEvent (name only; reduceThinking ignores tools, exactly like codex)
 *   - MessageDisplay / assistant text → a `{thinking}` AgentEvent (rendered into the panel)
 *   - Stop         → flush (no-op): thinking is pushed as it arrives; the session's `done` comes from
 *                    the driver's stdout EOF/`result`, NOT from the Stop hook.
 * SessionStart / UserPromptSubmit lifecycle events are ignored by the broker (the handler's standard
 * path already sends THINKING_START). A push into a room with no active session is a safe no-op.
 */
export function buildCcBridgeSink(registry: CcSessionRegistry): CcHookSink {
	return {
		tool: (roomId, _uid, toolName) => registry.push(roomId, { type: 'tool', name: toolName, phase: 'end' }),
		thinking: (roomId, _uid, text) => registry.push(roomId, { type: 'thinking', text }),
		flush: () => {
			/* no-op: thinking is pushed synchronously as hooks arrive; done comes from stdout EOF */
		},
	};
}
