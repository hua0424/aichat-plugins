import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveAgentSessionKey, resolveAgentContexts, handleSendMessage } from './send-message.js';
import { handleResetSession } from './reset-session.js';
import { postCapability } from '../capability/client.js';

vi.mock('../capability/client.js', () => ({ postCapability: vi.fn() }));

/**
 * REQ-010 S6 Phase-2 — resolveAgentSessionKey now also recognizes OPENCLAW_BIND.
 *
 * The openclaw agent's exec env gets OPENCLAW_BIND injected by aichat-claw's resolve_exec_env hook
 * (the bare `aiclaw-{uid}-room-{roomId}` binding). The CLI emits `openclaw:<binding>` so the loopback
 * capability routes it to the openclaw driver. Precedence: opencode > codex > openclaw (existing order).
 */
describe('resolveAgentSessionKey', () => {
	const SAVED = {
		OPENCODE_SESSION_ID: process.env.OPENCODE_SESSION_ID,
		CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
		OPENCLAW_BIND: process.env.OPENCLAW_BIND,
		AICHAT_BIND: process.env.AICHAT_BIND,
		AICHAT_CONTEXT_KEY: process.env.AICHAT_CONTEXT_KEY,
	};

	beforeEach(() => {
		delete process.env.OPENCODE_SESSION_ID;
		delete process.env.CODEX_THREAD_ID;
		delete process.env.OPENCLAW_BIND;
		delete process.env.AICHAT_BIND;
		delete process.env.AICHAT_CONTEXT_KEY;
	});

	afterEach(() => {
		for (const [k, v] of Object.entries(SAVED)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	it('OPENCLAW_BIND set → openclaw:<binding>', () => {
		process.env.OPENCLAW_BIND = 'aiclaw-1-room-2';
		expect(resolveAgentSessionKey()).toBe('openclaw:aiclaw-1-room-2');
	});

	it('OPENCODE_SESSION_ID wins over CODEX_THREAD_ID and OPENCLAW_BIND', () => {
		process.env.OPENCODE_SESSION_ID = 'ses_x';
		process.env.CODEX_THREAD_ID = 'thr_y';
		process.env.OPENCLAW_BIND = 'aiclaw-1-room-2';
		expect(resolveAgentSessionKey()).toBe('opencode:ses_x');
	});

	it('CODEX_THREAD_ID wins over OPENCLAW_BIND', () => {
		process.env.CODEX_THREAD_ID = 'thr_y';
		process.env.OPENCLAW_BIND = 'aiclaw-1-room-2';
		expect(resolveAgentSessionKey()).toBe('codex:thr_y');
	});

	it('AICHAT_BIND set → cc:<binding> (REQ-010 S7)', () => {
		process.env.AICHAT_BIND = 'aiclaw-3-room-4';
		expect(resolveAgentSessionKey()).toBe('cc:aiclaw-3-room-4');
	});

	it('OPENCLAW_BIND wins over AICHAT_BIND (cc is last in precedence)', () => {
		process.env.OPENCLAW_BIND = 'aiclaw-1-room-2';
		process.env.AICHAT_BIND = 'aiclaw-3-room-4';
		expect(resolveAgentSessionKey()).toBe('openclaw:aiclaw-1-room-2');
	});

	it('none set → undefined', () => {
		expect(resolveAgentSessionKey()).toBeUndefined();
	});

	it('V2 collects every inherited candidate instead of trusting the first driver', () => {
		process.env.AICHAT_CONTEXT_KEY = 'opaque-context';
		process.env.OPENCODE_SESSION_ID = 'ses_x';
		process.env.CODEX_THREAD_ID = 'thr_y';
		process.env.OPENCLAW_BIND = 'opaque-openclaw';
		process.env.AICHAT_BIND = 'opaque-cc';
		expect(resolveAgentContexts()).toEqual([
			{ key: 'opaque-context' },
			{ provider: 'opencode', nativeId: 'ses_x' },
			{ provider: 'codex', nativeId: 'thr_y' },
			{ provider: 'openclaw', nativeId: 'opaque-openclaw' },
			{ provider: 'cc', nativeId: 'opaque-cc' },
		]);
	});
});

describe('CLI write request ID', () => {
	const originalBind = process.env.AICHAT_BIND;
	const originalKey = process.env.AICHAT_CONTEXT_KEY;
	beforeEach(() => {
		delete process.env.AICHAT_CONTEXT_KEY;
		delete process.env.OPENCODE_SESSION_ID;
		delete process.env.CODEX_THREAD_ID;
		delete process.env.OPENCLAW_BIND;
		process.env.AICHAT_BIND = 'opaque-token';
	});
	afterEach(() => {
		if (originalBind === undefined) delete process.env.AICHAT_BIND;
		else process.env.AICHAT_BIND = originalBind;
		if (originalKey === undefined) delete process.env.AICHAT_CONTEXT_KEY;
		else process.env.AICHAT_CONTEXT_KEY = originalKey;
		vi.restoreAllMocks();
	});

	it('sends an explicit requestId without changing default success output', async () => {
		vi.mocked(postCapability).mockResolvedValue({ status: 200, body: { ok: true, result: { msgId: '91' } } });
		const out = vi.spyOn(console, 'log').mockImplementation(() => {});
		await handleSendMessage(['--content', ' hi ', '--request-id', 'retry-id']);
		expect(vi.mocked(postCapability).mock.calls.at(-1)?.[1]).toMatchObject({
			version: 2, contexts: [{ provider: 'cc', nativeId: 'opaque-token' }], command: 'send-message', requestId: 'retry-id', args: { content: 'hi' },
		});
		expect(out).toHaveBeenCalledWith('Message sent: {"msgId":"91"}');
	});

	it('generates IDs for writes, but honors an explicit reset ID', async () => {
		vi.mocked(postCapability).mockResolvedValue({ status: 200, body: { ok: true, result: { reset: false, driverType: 'cc' } } });
		vi.spyOn(console, 'log').mockImplementation(() => {});
		await handleSendMessage(['--content', 'first']);
		const id = (vi.mocked(postCapability).mock.calls.at(-1)?.[1] as { requestId: string }).requestId;
		expect(id).toMatch(/^[\da-f-]{36}$/);
		await handleResetSession(['--request-id', 'reset-1']);
		expect(vi.mocked(postCapability).mock.calls.at(-1)?.[1]).toMatchObject({ command: 'reset-session', requestId: 'reset-1' });
	});

	it('transport errors report the reusable ID rather than silently generating another request', async () => {
		vi.mocked(postCapability).mockRejectedValue(new Error('timeout'));
		const out = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
		await expect(handleSendMessage(['--content', 'hi', '--request-id', 'retry-id'])).rejects.toThrow('exit');
		expect(out).toHaveBeenCalledWith(expect.stringContaining('DELIVERY_UNKNOWN'));
		expect(out).toHaveBeenCalledWith(expect.stringContaining('--request-id retry-id'));
	});
});
