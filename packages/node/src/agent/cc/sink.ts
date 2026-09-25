import type { AgentEvent } from '../events.js';
import type { CcHookSink } from './broker.js';

/** Deliver hooks only to the exact identity, room and spawned attempt that registered them. */
export type CcEventPush = (ev: AgentEvent) => void;

export class CcSessionRegistry {
	private readonly byIdentity = new Map<string, Map<string, { runId: string; push: CcEventPush }>>();

	register(uid: string, roomId: string, runId: string, push: CcEventPush): () => void {
		let rooms = this.byIdentity.get(uid);
		if (!rooms) {
			rooms = new Map();
			this.byIdentity.set(uid, rooms);
		}
		const entry = { runId, push };
		rooms.set(roomId, entry);
		// Old completions and repeated cleanup cannot remove a newer run in the same room.
		return () => {
			if (rooms.get(roomId) !== entry) return;
			rooms.delete(roomId);
			if (rooms.size === 0) this.byIdentity.delete(uid);
		};
	}

	push(uid: string, roomId: string, runId: string, ev: AgentEvent): void {
		const entry = this.byIdentity.get(uid)?.get(roomId);
		if (entry?.runId === runId) entry.push(ev);
	}
}

/** Stop is intentionally inert: stdout result/EOF, not a hook, ends the turn. */
export function buildCcBridgeSink(registry: CcSessionRegistry): CcHookSink {
	return {
		tool: (roomId, uid, runId, toolName) => registry.push(uid, roomId, runId, { type: 'tool', name: toolName, phase: 'end' }),
		flush: () => {},
	};
}
