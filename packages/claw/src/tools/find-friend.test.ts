import { describe, it, expect, vi } from 'vitest';
import { createFindFriendTool } from './find-friend.js';
import type { ToolContext } from '../types.js';
import type { HulaApiClient } from '../hula-api.js';
import type { HulaApiClientPool } from '../hula-api-pool.js';

function fakeClient(friends: unknown[] = []) {
	return {
		searchFriends: vi.fn().mockResolvedValue(friends),
	} as unknown as HulaApiClient & { searchFriends: ReturnType<typeof vi.fn> };
}

function fakePool(clients: Record<string, HulaApiClient>) {
	return {
		get: vi.fn((aiclawUid?: string) => {
			if (aiclawUid && clients[aiclawUid]) return clients[aiclawUid];
			throw new Error(`no client for ${aiclawUid}`);
		}),
	} as unknown as HulaApiClientPool;
}

const ctx = (sessionKey: string): ToolContext => ({ sessionKey });

describe('createFindFriendTool (factory)', () => {
	it('searches using the aiclaw client bound from sessionKey', async () => {
		const clientA = fakeClient([{ uid: 9, name: 'Bob' }]);
		const pool = fakePool({ '100': clientA });
		const tool = createFindFriendTool(pool, ctx('aiclaw-100-room-1'));

		const result = await tool.execute('a', { keyword: 'Bob' });
		expect(clientA.searchFriends).toHaveBeenCalledWith('Bob');
		expect(result).toEqual({ friends: [{ uid: 9, name: 'Bob' }] });
	});

	it('rejects unparseable sessionKey', async () => {
		const clientA = fakeClient();
		const pool = fakePool({ '100': clientA });
		const tool = createFindFriendTool(pool, ctx('nope'));

		const result = await tool.execute('b', { keyword: 'Bob' });
		expect(result).toHaveProperty('error');
		expect(clientA.searchFriends).not.toHaveBeenCalled();
	});

	it('returns { error } (does not throw) when searchFriends rejects', async () => {
		const clientA = fakeClient();
		// API 失败：searchFriends 拒绝 → execute 必须捕获并返回 { error }，不外抛
		clientA.searchFriends.mockRejectedValueOnce(new Error('network down'));
		const pool = fakePool({ '100': clientA });
		const tool = createFindFriendTool(pool, ctx('aiclaw-100-room-1'));

		const result = await tool.execute('d', { keyword: 'Bob' });
		expect(result).toHaveProperty('error');
	});

	it('rejects empty keyword', async () => {
		const clientA = fakeClient();
		const pool = fakePool({ '100': clientA });
		const tool = createFindFriendTool(pool, ctx('aiclaw-100-room-1'));

		const result = await tool.execute('c', { keyword: '  ' });
		expect(result).toHaveProperty('error');
		expect(clientA.searchFriends).not.toHaveBeenCalled();
	});
});
