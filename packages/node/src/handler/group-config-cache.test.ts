import { describe, it, expect } from 'vitest';
import { GroupConfigCache, type GroupConfig } from './group-config-cache.js';

/**
 * REQ-029 (#29): roomId is an opaque string end-to-end. server serializes large Java Long roomIds as
 * JSON strings; a `Number()` of a value > 2^53-1 collapses distinct rooms onto the same numeric key
 * (`Number('9007199254740993') === 9007199254740992`). The cache MUST key by the exact string so two
 * rooms differing only beyond 2^53 never collide.
 */
function cfg(overrides: Partial<GroupConfig> = {}): GroupConfig {
	return { rateLimitPerMinute: 0, mentionRequired: true, dailyLimit: 0, respondToAi: false, approved: false, ...overrides };
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

/**
 * aichatoverview#484 (T3)：WS 提示只作失效信号。
 * 这里锁住 interval 里最关键的两条：过期标记不应用载荷、代次能丢弃早于最新提示的慢响应。
 */
describe('GroupConfigCache — #484 stale hint semantics', () => {
	const UID = '163589881742848';
	const ROOM = '9';

	it('approved 缺省不得当 true（服务端默认 0=未批准）', () => {
		const cache = new GroupConfigCache();
		cache.set(UID, ROOM, { rateLimitPerMinute: 0, mentionRequired: true, dailyLimit: 0, respondToAi: true } as GroupConfig);
		expect(cache.get(UID, ROOM)?.approved).toBe(false);
	});

	it('markStale 只标记过期并推进代次，旧值原样保留', () => {
		const cache = new GroupConfigCache();
		cache.set(UID, ROOM, cfg({ rateLimitPerMinute: 5, approved: true }));
		expect(cache.isStale(UID, ROOM)).toBe(false);

		const generation = cache.markStale(UID, ROOM);

		expect(generation).toBe(1);
		expect(cache.isStale(UID, ROOM)).toBe(true);
		expect(cache.get(UID, ROOM)).toMatchObject({ rateLimitPerMinute: 5, approved: true });
	});

	it('set 用旧代次回写会被拒绝（慢响应不得盖回更新的事实）', () => {
		const cache = new GroupConfigCache();
		cache.set(UID, ROOM, cfg({ approved: false }));
		const generation = cache.generationOf(UID, ROOM);

		// 提示到达 → 代次推进。
		cache.markStale(UID, ROOM);

		// 先前进发的读取带着旧代次返回 → 必须丢弃。
		const applied = cache.set(UID, ROOM, cfg({ approved: true }), generation);

		expect(applied).toBe(false);
		expect(cache.get(UID, ROOM)?.approved).toBe(false);
		expect(cache.isStale(UID, ROOM)).toBe(true);
	});

	it('set 用当前代次回写会清除过期标记', () => {
		const cache = new GroupConfigCache();
		cache.set(UID, ROOM, cfg({ approved: false }));
		cache.markStale(UID, ROOM);

		const applied = cache.set(UID, ROOM, cfg({ approved: true }), cache.generationOf(UID, ROOM));

		expect(applied).toBe(true);
		expect(cache.isStale(UID, ROOM)).toBe(false);
		expect(cache.get(UID, ROOM)?.approved).toBe(true);
	});

	it('无记录时 markStale 返回 0（仍允许首次当前读）', () => {
		const cache = new GroupConfigCache();
		expect(cache.markStale(UID, ROOM)).toBe(0);
	});
});
