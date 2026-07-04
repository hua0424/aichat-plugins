import { describe, it, expect } from 'vitest';
import { buildOpenclawExecEnv, extractExecEnvSessionKey } from './exec-env.js';

/**
 * REQ-010 S6 Phase-2 / #141 B+ — buildOpenclawExecEnv: pure helper for the resolve_exec_env hook.
 *
 * openclaw fires the hook with a ctx.sessionKey of the openclaw-normalized COMPOUND form
 * `agent:main:<token>:aiclaw-{uid}-room-{roomId}` (node builds `<token>:<binding>`; openclaw wraps it
 * with `agent:main:`). We strip the namespace prefix and extract the BARE opaque token PREFIX (the part
 * before the `:aiclaw-…-room-…` binding suffix) → `{ OPENCLAW_BIND: <token> }`, which the CLI reads to
 * emit an `openclaw:<token>` capability session key. The tail binding is only for the in-gateway tool
 * (via ctx.sessionKey), not for the CLI path. Anything that is not a well-formed compound yields `{}`
 * (inject nothing, never throw).
 */
describe('buildOpenclawExecEnv', () => {
	it('agent:main:<token>:<binding> → { OPENCLAW_BIND: <token> } (extracts the token prefix)', () => {
		expect(
			buildOpenclawExecEnv('agent:main:TOKEN123:aiclaw-140789091499520-room-163347643904512'),
		).toEqual({ OPENCLAW_BIND: 'TOKEN123' });
	});

	it('the canonical example: token prefix + binding tail → the token only', () => {
		expect(buildOpenclawExecEnv('agent:main:TOKEN123:aiclaw-1-room-2')).toEqual({
			OPENCLAW_BIND: 'TOKEN123',
		});
	});

	it('a base64url token (contains - and _) is extracted intact', () => {
		// the real minted token is base64url (`[A-Za-z0-9_-]`, no `:`), so `-`/`_` inside it must survive.
		const token = 'aB3-_xYz09-QW_er';
		expect(buildOpenclawExecEnv(`agent:main:${token}:aiclaw-5-room-9`)).toEqual({
			OPENCLAW_BIND: token,
		});
	});

	it('missing / empty / null / undefined → {}', () => {
		expect(buildOpenclawExecEnv('')).toEqual({});
		expect(buildOpenclawExecEnv(null)).toEqual({});
		expect(buildOpenclawExecEnv(undefined)).toEqual({});
	});

	it('non agent:main: prefix → {} (do not inject)', () => {
		// bare compound without the openclaw namespace prefix is not injected
		expect(buildOpenclawExecEnv('TOKEN123:aiclaw-1-room-2')).toEqual({});
		expect(buildOpenclawExecEnv('agent:other:TOKEN123:aiclaw-1-room-2')).toEqual({});
		expect(buildOpenclawExecEnv('foo:bar')).toEqual({});
	});

	it('agent:main: prefix but non-compound garbage (no binding suffix) → {} (inject nothing)', () => {
		// without a well-formed `:aiclaw-\d+-room-\d+` tail there is no compound to split → {}.
		expect(buildOpenclawExecEnv('agent:main:aiclaw-1-room-')).toEqual({});
		expect(buildOpenclawExecEnv('agent:main:aiclaw--room-2')).toEqual({});
		expect(buildOpenclawExecEnv('agent:main:aiclaw-abc-room-2')).toEqual({});
		expect(buildOpenclawExecEnv('agent:main:notaiclaw-1-room-2')).toEqual({});
		expect(buildOpenclawExecEnv('agent:main:')).toEqual({});
		expect(buildOpenclawExecEnv('agent:main:garbage')).toEqual({});
	});

	it('never throws on odd input', () => {
		expect(() => buildOpenclawExecEnv(123 as unknown as string)).not.toThrow();
		expect(() => buildOpenclawExecEnv({} as unknown as string)).not.toThrow();
		expect(buildOpenclawExecEnv(123 as unknown as string)).toEqual({});
	});
});

describe('extractExecEnvSessionKey', () => {
	const SK = 'agent:main:aiclaw-1-room-2';

	it('prefers ctx.sessionKey (2nd arg) — the real handler shape', () => {
		expect(extractExecEnvSessionKey(undefined, { sessionKey: SK })).toBe(SK);
	});

	it('ctx.sessionKey wins over event fallbacks', () => {
		expect(
			extractExecEnvSessionKey({ ctx: { sessionKey: 'other' }, sessionKey: 'other2' }, { sessionKey: SK }),
		).toBe(SK);
	});

	it('falls back to event.ctx.sessionKey when ctx absent', () => {
		expect(extractExecEnvSessionKey({ ctx: { sessionKey: SK } })).toBe(SK);
	});

	it('falls back to event.sessionKey last', () => {
		expect(extractExecEnvSessionKey({ sessionKey: SK })).toBe(SK);
	});

	it('returns undefined when no sessionKey anywhere / non-string', () => {
		expect(extractExecEnvSessionKey(undefined, undefined)).toBeUndefined();
		expect(extractExecEnvSessionKey({}, {})).toBeUndefined();
		expect(extractExecEnvSessionKey({ sessionKey: null }, { sessionKey: undefined })).toBeUndefined();
		expect(extractExecEnvSessionKey({ sessionKey: 42 as unknown as string })).toBeUndefined();
	});

	it('never throws', () => {
		expect(() => extractExecEnvSessionKey(null)).not.toThrow();
	});
});
