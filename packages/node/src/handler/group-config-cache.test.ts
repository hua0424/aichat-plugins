import { describe, it, expect } from 'vitest';
import { GroupConfigCache, type GroupConfig } from './group-config-cache.js';

/**
 * REQ-029 (#29): roomId is an opaque string end-to-end. server serializes large Java Long roomIds as
 * JSON strings; a `Number()` of a value > 2^53-1 collapses distinct rooms onto the same numeric key
 * (`Number('9007199254740993') === 9007199254740992`). The cache MUST key by the exact string so two
 * rooms differing only beyond 2^53 never collide.
 */
function cfg(overrides: Partial<GroupConfig> = {}): GroupConfig {
	return { rateLimitPerMinute: 0, mentionRequired: true, dailyLimit: 0, respondToAi: false, ...overrides };
}

describe('GroupConfigCache — >2^53 roomId precision (REQ-029 #29)', () => {
	// Number('9007199254740993') === 9007199254740992 → these two strings would collide if Number()'d.
	const A = '9007199254740993';
	const B = '9007199254740992';
	const UID = '163589881742848';

	it('no cross-room collision: config set on A is NOT returned for the adjacent room B', () => {
		const cache = new GroupConfigCache();
		cache.set(UID, A, cfg({ rateLimitPerMinute: 7 }));
		// B differs from A only beyond 2^53; a Number()-keyed cache would return A's config here.
		expect(cache.get(UID, B)).toBeUndefined();
	});

	it('exact-string get returns the stored config', () => {
		const cache = new GroupConfigCache();
		const stored = cfg({ rateLimitPerMinute: 7, respondToAi: true });
		cache.set(UID, A, stored);
		expect(cache.get(UID, A)).toMatchObject({ rateLimitPerMinute: 7, respondToAi: true });
	});

	it('delete targets the exact-string room only', () => {
		const cache = new GroupConfigCache();
		cache.set(UID, A, cfg());
		cache.set(UID, B, cfg());
		cache.delete(UID, A);
		expect(cache.get(UID, A)).toBeUndefined();
		expect(cache.get(UID, B)).toBeDefined();
	});
});
