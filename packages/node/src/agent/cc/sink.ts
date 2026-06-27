import type { ExternalThinkingSink } from './broker.js';

/**
 * REQ-010 S7 — build the CcBroker sink that routes mirrored CC activity to the matching identity's
 * MessageHandler external-thinking methods, looked up by uid.
 *
 * The broker resolves a binding → (aiclawUid, roomId) and calls sink.begin/delta/end(roomId, uid).
 * This sink finds the supervised identity whose uid matches and forwards to its handler. A binding
 * whose uid has no live handler (degraded/absent) is a safe no-op (optional chaining), never a throw.
 */

/** The slice of a supervised identity this sink needs: its uid + the external-thinking handler methods. */
export interface CcSinkAgent {
	uid: number;
	handler: {
		beginExternalThinking(roomId: number, fromUid: number): void;
		externalThinkingDelta(roomId: number, fromUid: number, text: string): void;
		endExternalThinking(roomId: number, fromUid: number): void;
	};
}

export function buildCcSink(agents: () => ReadonlyArray<CcSinkAgent>): ExternalThinkingSink {
	const find = (uid: number) => agents().find((a) => a.uid === uid);
	return {
		begin: (roomId, uid) => find(uid)?.handler.beginExternalThinking(roomId, uid),
		delta: (roomId, uid, text) => find(uid)?.handler.externalThinkingDelta(roomId, uid, text),
		end: (roomId, uid) => find(uid)?.handler.endExternalThinking(roomId, uid),
	};
}
