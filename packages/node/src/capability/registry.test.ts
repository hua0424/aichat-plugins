import { describe, it, expect, vi } from 'vitest';
import {
	CapabilityRegistry,
	sendMessageCapability,
	memberInfoCapability,
	listFriendsCapability,
	findFriendCapability,
	listGroupsCapability,
	listGroupMembersCapability,
	type CapabilityContext,
} from './registry.js';
import type { HulaApiClient } from '../api/hula-api.js';

function fakeCtx(roomId: number) {
	const sendMessage = vi.fn(async () => ({ msgId: 42 }));
	const apiClient = { sendMessage } as unknown as HulaApiClient;
	const ctx: CapabilityContext = { aiclawUid: 7, roomId, apiClient };
	return { ctx, sendMessage };
}

describe('sendMessageCapability', () => {
	it('calls apiClient.sendMessage(roomId, content) with the ctx roomId', async () => {
		const { ctx, sendMessage } = fakeCtx(42);
		const cap = sendMessageCapability();
		const result = await cap(ctx, { content: 'hello' });
		expect(sendMessage).toHaveBeenCalledWith(42, 'hello');
		expect(result).toEqual({ msgId: 42, roomId: 42 });
	});

	it('room comes from ctx, NEVER from args (args.room ignored)', async () => {
		const { ctx, sendMessage } = fakeCtx(42);
		const cap = sendMessageCapability();
		await cap(ctx, { content: 'hi', room: 999 });
		// the spoofed args.room=999 is ignored — the ctx roomId 42 is used
		expect(sendMessage).toHaveBeenCalledWith(42, 'hi');
	});

	it('trims content', async () => {
		const { ctx, sendMessage } = fakeCtx(42);
		await sendMessageCapability()(ctx, { content: '  padded  ' });
		expect(sendMessage).toHaveBeenCalledWith(42, 'padded');
	});

	it('empty / whitespace / non-string content throws', async () => {
		const { ctx } = fakeCtx(42);
		const cap = sendMessageCapability();
		await expect(cap(ctx, { content: '' })).rejects.toThrow();
		await expect(cap(ctx, { content: '   ' })).rejects.toThrow();
		await expect(cap(ctx, {})).rejects.toThrow();
		await expect(cap(ctx, { content: 123 })).rejects.toThrow();
	});
});

describe('memberInfoCapability (REQ-010 S3)', () => {
	function ctxWith(getMemberInfo: ReturnType<typeof vi.fn>) {
		const apiClient = { getMemberInfo } as unknown as HulaApiClient;
		return { aiclawUid: 7, roomId: 42, apiClient } as CapabilityContext;
	}

	it('calls apiClient.getMemberInfo(uid) and returns { uid, profile }', async () => {
		const profile = { uid: 555, name: 'Alice' };
		const getMemberInfo = vi.fn(async () => profile);
		const ctx = ctxWith(getMemberInfo);
		const out = await memberInfoCapability()(ctx, { uid: 555 });
		// REQ-029 (#29): uid kept as an opaque numeric string end-to-end.
		expect(getMemberInfo).toHaveBeenCalledWith('555');
		expect(out).toEqual({ uid: '555', profile });
	});

	it('coerces a numeric-string uid to a positive integer', async () => {
		const getMemberInfo = vi.fn(async () => ({}));
		const ctx = ctxWith(getMemberInfo);
		await memberInfoCapability()(ctx, { uid: '555' });
		expect(getMemberInfo).toHaveBeenCalledWith('555');
	});

	it('rejects missing / invalid / non-positive uid', async () => {
		const getMemberInfo = vi.fn(async () => ({}));
		const ctx = ctxWith(getMemberInfo);
		const cap = memberInfoCapability();
		await expect(cap(ctx, {})).rejects.toThrow();
		await expect(cap(ctx, { uid: 0 })).rejects.toThrow();
		await expect(cap(ctx, { uid: -3 })).rejects.toThrow();
		await expect(cap(ctx, { uid: 1.5 })).rejects.toThrow();
		await expect(cap(ctx, { uid: 'abc' })).rejects.toThrow();
		expect(getMemberInfo).not.toHaveBeenCalled();
	});
});

describe('listFriendsCapability (REQ-010 S3)', () => {
	it('calls apiClient.listFriends() and returns { friends }', async () => {
		const friends = [{ uid: 1, name: 'A' }];
		const listFriends = vi.fn(async () => friends);
		const apiClient = { listFriends } as unknown as HulaApiClient;
		const ctx: CapabilityContext = { aiclawUid: 7, roomId: 42, apiClient };
		const out = await listFriendsCapability()(ctx, {});
		expect(listFriends).toHaveBeenCalledTimes(1);
		expect(out).toEqual({ friends });
	});
});

describe('findFriendCapability (REQ-010 S3)', () => {
	function ctxWith(searchUsers: ReturnType<typeof vi.fn>) {
		const apiClient = { searchUsers } as unknown as HulaApiClient;
		return { aiclawUid: 7, roomId: 42, apiClient } as CapabilityContext;
	}

	it('calls apiClient.searchUsers(keyword) and returns { keyword, users }', async () => {
		const users = [{ uid: 1, name: 'A' }];
		const searchUsers = vi.fn(async () => users);
		const ctx = ctxWith(searchUsers);
		const out = await findFriendCapability()(ctx, { keyword: '  bob  ' });
		// keyword is trimmed
		expect(searchUsers).toHaveBeenCalledWith('bob');
		expect(out).toEqual({ keyword: 'bob', users });
	});

	it('rejects empty / whitespace / non-string keyword', async () => {
		const searchUsers = vi.fn(async () => []);
		const ctx = ctxWith(searchUsers);
		const cap = findFriendCapability();
		await expect(cap(ctx, {})).rejects.toThrow();
		await expect(cap(ctx, { keyword: '' })).rejects.toThrow();
		await expect(cap(ctx, { keyword: '   ' })).rejects.toThrow();
		await expect(cap(ctx, { keyword: 123 })).rejects.toThrow();
		expect(searchUsers).not.toHaveBeenCalled();
	});
});

describe('listGroupsCapability (REQ-010 S4)', () => {
	it('calls apiClient.listGroups() and returns { groups }', async () => {
		const groups = [{ groupId: 1, roomId: 2, groupName: 'G' }];
		const listGroups = vi.fn(async () => groups);
		const apiClient = { listGroups } as unknown as HulaApiClient;
		const ctx: CapabilityContext = { aiclawUid: 7, roomId: 42, apiClient };
		const out = await listGroupsCapability()(ctx, {});
		expect(listGroups).toHaveBeenCalledTimes(1);
		expect(out).toEqual({ groups });
	});
});

describe('listGroupMembersCapability (REQ-010 S4)', () => {
	function ctxWith(listGroupMembers: ReturnType<typeof vi.fn>, roomId = 42) {
		const apiClient = { listGroupMembers } as unknown as HulaApiClient;
		return { aiclawUid: 7, roomId, apiClient } as CapabilityContext;
	}

	it('defaults to ctx.roomId, online=false, returns { roomId, online, members }', async () => {
		const members = [{ uid: 1, name: 'A', online: true }];
		const listGroupMembers = vi.fn(async () => members);
		const ctx = ctxWith(listGroupMembers, 42);
		const out = await listGroupMembersCapability()(ctx, {});
		expect(listGroupMembers).toHaveBeenCalledWith(42, false);
		expect(out).toEqual({ roomId: 42, online: false, members });
	});

	it('uses args.groupid when given (a DIFFERENT room than ctx.roomId)', async () => {
		const listGroupMembers = vi.fn(async () => []);
		const ctx = ctxWith(listGroupMembers, 42);
		await listGroupMembersCapability()(ctx, { groupid: 999 });
		expect(listGroupMembers).toHaveBeenCalledWith('999', false);
	});

	it('coerces a numeric-string groupid', async () => {
		const listGroupMembers = vi.fn(async () => []);
		const ctx = ctxWith(listGroupMembers, 42);
		await listGroupMembersCapability()(ctx, { groupid: '999' });
		expect(listGroupMembers).toHaveBeenCalledWith('999', false);
	});

	it('passes the online flag (true / "true")', async () => {
		const listGroupMembers = vi.fn(async () => []);
		const ctx = ctxWith(listGroupMembers, 42);
		await listGroupMembersCapability()(ctx, { online: true });
		expect(listGroupMembers).toHaveBeenLastCalledWith(42, true);
		await listGroupMembersCapability()(ctx, { online: 'true' });
		expect(listGroupMembers).toHaveBeenLastCalledWith(42, true);
	});

	it('throws on a non-numeric groupid', async () => {
		const listGroupMembers = vi.fn(async () => []);
		const ctx = ctxWith(listGroupMembers, 42);
		const cap = listGroupMembersCapability();
		await expect(cap(ctx, { groupid: 'abc' })).rejects.toThrow('invalid --groupid');
		await expect(cap(ctx, { groupid: 0 })).rejects.toThrow('invalid --groupid');
		await expect(cap(ctx, { groupid: -1 })).rejects.toThrow('invalid --groupid');
		expect(listGroupMembers).not.toHaveBeenCalled();
	});

	it('returns { roomId, error } (NOT throw) when apiClient rejects with a business error', async () => {
		const listGroupMembers = vi.fn(async () => {
			throw new Error('HuLa API failed: 当前不在群聊中');
		});
		const ctx = ctxWith(listGroupMembers, 42);
		const out = await listGroupMembersCapability()(ctx, {});
		expect(out).toEqual({ roomId: 42, error: 'HuLa API failed: 当前不在群聊中' });
	});
});

describe('CapabilityRegistry', () => {
	it('register + has + invoke a registered capability', async () => {
		const reg = new CapabilityRegistry();
		const cap = vi.fn(async () => ({ ok: 1 }));
		reg.register('thing', cap);
		expect(reg.has('thing')).toBe(true);
		const { ctx } = fakeCtx(1);
		const out = await reg.invoke('thing', ctx, { a: 1 });
		expect(cap).toHaveBeenCalledWith(ctx, { a: 1 });
		expect(out).toEqual({ ok: 1 });
	});

	it('has() is false for an unregistered name', () => {
		expect(new CapabilityRegistry().has('nope')).toBe(false);
	});

	it('invoke() of an unknown command throws', async () => {
		const reg = new CapabilityRegistry();
		const { ctx } = fakeCtx(1);
		await expect(reg.invoke('nope', ctx, {})).rejects.toThrow();
	});
});
