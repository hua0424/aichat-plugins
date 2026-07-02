import { describe, it, expect } from 'vitest';
import { AntiLoopGuard } from './anti-loop.js';

/**
 * REQ-029 (#29): roomId/fromUid/selfUid are opaque strings. The per-room AI-to-AI round counter is
 * keyed by the exact roomId string; two rooms differing only beyond 2^53 must keep INDEPENDENT counts
 * (a `Number()`-keyed map would collapse them onto one bucket, cross-contaminating the backoff state).
 */
describe('AntiLoopGuard — >2^53 roomId isolation (REQ-029 #29)', () => {
	// Number('9007199254740993') === 9007199254740992 → these collide if Number()'d.
	const A = '9007199254740993';
	const B = '9007199254740992';
	const SELF = '999';
	const PEER1 = '200';
	const PEER2 = '201';

	/** Drive one trigger-eligible peer-AI round (alternating peer uids so consecutive AI rounds count). */
	function aiRound(guard: AntiLoopGuard, roomId: string, fromUid: string) {
		guard.check({ roomId, fromUid, selfUid: SELF, content: 'ai', isFromAi: true });
	}

	it('two rooms differing only beyond 2^53 keep independent getAiRoundCount', () => {
		const guard = new AntiLoopGuard();
		// Six AI-to-AI rounds in room A only (alternate peers so each increments the counter).
		for (let i = 0; i < 6; i++) aiRound(guard, A, i % 2 === 0 ? PEER1 : PEER2);

		expect(guard.getAiRoundCount(A)).toBeGreaterThan(0);
		// Room B (adjacent past 2^53) has seen NOTHING — a Number()-collided key would report A's count.
		expect(guard.getAiRoundCount(B)).toBe(0);
	});

	it('a human message in room A does not reset room B (independent state)', () => {
		const guard = new AntiLoopGuard();
		for (let i = 0; i < 3; i++) aiRound(guard, B, i % 2 === 0 ? PEER1 : PEER2);
		const bBefore = guard.getAiRoundCount(B);
		// human turn in A
		guard.check({ roomId: A, fromUid: PEER1, selfUid: SELF, content: 'hi', isFromAi: false });
		expect(guard.getAiRoundCount(B)).toBe(bBefore);
	});
});
