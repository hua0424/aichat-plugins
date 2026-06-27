import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveAgentSessionKey } from './send-message.js';

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
	};

	beforeEach(() => {
		delete process.env.OPENCODE_SESSION_ID;
		delete process.env.CODEX_THREAD_ID;
		delete process.env.OPENCLAW_BIND;
		delete process.env.AICHAT_BIND;
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
});
