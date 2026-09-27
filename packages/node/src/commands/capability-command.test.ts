import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { postCapability } from '../capability/client.js';
import { runCapabilityCommand } from './capability-command.js';
import { handleListGroupMembers } from './list-group-members.js';
import { handleMemberInfo } from './member-info.js';
import { handleListFriends } from './list-friends.js';
import { handleFindFriend } from './find-friend.js';
import { handleListGroups } from './list-groups.js';
import { handleSendMessage } from './send-message.js';
import { handleResetSession } from './reset-session.js';

vi.mock('../capability/client.js', () => ({ postCapability: vi.fn() }));
const saved = Object.fromEntries(['AICHAT_CONTEXT_KEY', 'OPENCODE_SESSION_ID', 'CODEX_THREAD_ID', 'OPENCLAW_BIND', 'AICHAT_BIND']
	.map((key) => [key, process.env[key]]));
const mocked = vi.mocked(postCapability);

beforeEach(() => {
	for (const key of Object.keys(saved)) delete process.env[key];
	process.env.AICHAT_CONTEXT_KEY = 'secret-context';
	mocked.mockReset();
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
});
afterEach(() => {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
	vi.restoreAllMocks();
});

const output = () => vi.mocked(console.log).mock.calls.at(-1)?.[0] as string;

describe('unified CLI capability contract', () => {
	it.each([
		['opencode', 'OPENCODE_SESSION_ID'], ['codex', 'CODEX_THREAD_ID'],
		['openclaw', 'OPENCLAW_BIND'], ['cc', 'AICHAT_BIND'],
	] as const)('sends all inherited %s descriptor candidates to core without loading credentials', async (provider, envName) => {
		process.env[envName] = 'opaque-native';
		mocked.mockResolvedValue({ status: 200, body: { ok: true, result: { friends: [] } } });
		await handleListFriends(['--json']);
		expect(mocked.mock.calls[0][1]).toMatchObject({ version: 2, contexts: [
			{ key: 'secret-context' }, { provider, nativeId: 'opaque-native' },
		], command: 'list-friends', args: {} });
		expect(output()).toBe('{"ok":true,"result":{"friends":[]}}');
	});

	it('rejects actor/room claims before IPC without including opaque tokens in output', async () => {
		await expect(handleSendMessage(['--content', 'hello', '--room', 'other', '--json'])).rejects.toThrow('exit');
		expect(JSON.parse(output())).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT', retryable: false });
		expect(output()).not.toContain('secret-context');
		expect(mocked).not.toHaveBeenCalled();
	});

	it('queries are uncached reads without requestId, targets never become actor or default room', async () => {
		mocked.mockResolvedValue({ status: 200, body: { ok: true, result: {} } });
		await handleMemberInfo(['42', '--json']);
		await handleFindFriend(['alice', '--json']);
		await handleListGroups(['--json']);
		await handleListGroupMembers(['--groupid', '9007199254740993', '--json']);
		for (const [, body] of mocked.mock.calls) {
			expect(body).not.toHaveProperty('requestId');
			expect(body).not.toHaveProperty('idempotencyKey');
			expect((body as { contexts: unknown[] }).contexts).toEqual([{ key: 'secret-context' }]);
		}
		expect(mocked.mock.calls[0][1]).toMatchObject({ args: { uid: '42' } });
		expect(mocked.mock.calls[3][1]).toMatchObject({ args: { groupid: '9007199254740993' } });
	});

	it('keeps legacy group result.error stdout/exit0 but --json returns stable failure/nonzero', async () => {
		mocked.mockResolvedValue({ status: 200, body: { ok: true, result: { roomId: '8', error: 'not joined', code: 'FORBIDDEN', retryable: false } } });
		await handleListGroupMembers([]);
		expect(output()).toBe('{"roomId":"8","error":"not joined"}');
		await expect(handleListGroupMembers(['--json'])).rejects.toThrow('exit');
		expect(JSON.parse(output())).toMatchObject({ ok: false, code: 'FORBIDDEN', message: 'not joined', retryable: false });
	});

	it('only a confirmed successful write reports JSON ok/result with its bound request ID', async () => {
		mocked.mockResolvedValue({ status: 200, body: { ok: true, result: { msgId: '1', roomId: '42' } } });
		await handleSendMessage(['--content', 'hello', '--request-id', 'send-1', '--json']);
		expect(mocked.mock.calls[0][1]).toMatchObject({ command: 'send-message', requestId: 'send-1', args: { content: 'hello' } });
		expect(JSON.parse(output())).toEqual({ ok: true, result: { msgId: '1', roomId: '42' } });
	});

	it('provides JSON stable errors and write IDs without swallowing delivery uncertainty', async () => {
		mocked.mockResolvedValueOnce({ status: 409, body: { ok: false, code: 'AMBIGUOUS_CONTEXT', error: 'conflicting candidates' } });
		await expect(handleResetSession(['--json'])).rejects.toThrow('exit');
		expect(JSON.parse(output())).toMatchObject({ ok: false, code: 'AMBIGUOUS_CONTEXT' });
		mocked.mockRejectedValueOnce(new Error('secret transport token'));
		await expect(handleSendMessage(['--content', 'hi', '--request-id', 'retry-me', '--json'])).rejects.toThrow('exit');
		expect(JSON.parse(output())).toMatchObject({ ok: false, code: 'DELIVERY_UNKNOWN', requestId: 'retry-me' });
		expect(output()).not.toContain('secret transport token');
	});

	it('permits registering a new query at the generic CLI/core seam without changing an adapter', async () => {
		mocked.mockResolvedValue({ status: 200, body: { ok: true, result: { answer: 1 } } });
		await runCapabilityCommand('fake-read', ['--json'], JSON.stringify);
		expect(mocked.mock.calls[0][1]).toMatchObject({ version: 2, command: 'fake-read', args: {} });
		expect(output()).toBe('{"ok":true,"result":{"answer":1}}');
	});
});
