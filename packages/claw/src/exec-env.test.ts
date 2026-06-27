import { describe, it, expect } from 'vitest';
import { buildOpenclawExecEnv, extractExecEnvSessionKey } from './exec-env.js';

/**
 * REQ-010 S6 Phase-2 — buildOpenclawExecEnv: pure helper for the resolve_exec_env hook.
 *
 * Maps an openclaw-normalized sessionKey (`agent:main:aiclaw-{uid}-room-{roomId}`) to the
 * env vars to MERGE into the agent's exec invocation. Only a well-formed binding yields
 * `{ OPENCLAW_BIND: <binding> }`; everything else yields `{}` (inject nothing, never throw).
 */
describe('buildOpenclawExecEnv', () => {
	it('agent:main:<binding> → { OPENCLAW_BIND: <binding> }', () => {
		expect(
			buildOpenclawExecEnv('agent:main:aiclaw-140789091499520-room-163347643904512'),
		).toEqual({ OPENCLAW_BIND: 'aiclaw-140789091499520-room-163347643904512' });
	});

	it('small ids still map', () => {
		expect(buildOpenclawExecEnv('agent:main:aiclaw-1-room-2')).toEqual({
			OPENCLAW_BIND: 'aiclaw-1-room-2',
		});
	});

	it('missing / empty / null / undefined → {}', () => {
		expect(buildOpenclawExecEnv('')).toEqual({});
		expect(buildOpenclawExecEnv(null)).toEqual({});
		expect(buildOpenclawExecEnv(undefined)).toEqual({});
	});

	it('non agent:main: prefix → {} (do not inject)', () => {
		// bare binding without the openclaw namespace prefix is not injected
		expect(buildOpenclawExecEnv('aiclaw-1-room-2')).toEqual({});
		expect(buildOpenclawExecEnv('agent:other:aiclaw-1-room-2')).toEqual({});
		expect(buildOpenclawExecEnv('foo:bar')).toEqual({});
	});

	it('agent:main: prefix but malformed binding → {} (never inject a malformed binding)', () => {
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
