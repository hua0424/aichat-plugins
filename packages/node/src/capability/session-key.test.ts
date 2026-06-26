import { describe, it, expect } from 'vitest';
import { parseSessionKey, KNOWN_PREFIXES, resolveBoundSession } from './session-key.js';
import type { AgentDriver } from '../agent/events.js';
import type { HulaApiClient } from '../api/hula-api.js';

/** A supervised-agent stub: a driver of a given type (optionally able to resolveSession) + uid + api. */
function agent(opts: {
	type: string;
	uid: number;
	resolve?: (id: string) => { aiclawUid: number; roomId: number } | undefined;
}): { driver: AgentDriver; uid: number; api: HulaApiClient } {
	const api = { __id: opts.uid } as unknown as HulaApiClient;
	const driver = { type: opts.type, resolveSession: opts.resolve } as unknown as AgentDriver;
	return { driver, uid: opts.uid, api };
}

describe('parseSessionKey', () => {
	it('opencode:ses_x → { agentType: opencode, id: ses_x }', () => {
		expect(parseSessionKey('opencode:ses_x')).toEqual({ agentType: 'opencode', id: 'ses_x' });
	});

	it('codex:thr_y → { agentType: codex, id: thr_y } (forward-compat prefix)', () => {
		expect(parseSessionKey('codex:thr_y')).toEqual({ agentType: 'codex', id: 'thr_y' });
	});

	it('unprefixed raw key → undefined', () => {
		expect(parseSessionKey('ses_x')).toBeUndefined();
	});

	it('unknown prefix → undefined', () => {
		expect(parseSessionKey('foo:bar')).toBeUndefined();
	});

	it('known prefix with empty id → undefined', () => {
		expect(parseSessionKey('opencode:')).toBeUndefined();
	});

	it('KNOWN_PREFIXES maps prefixes to AgentDriver.type', () => {
		expect(KNOWN_PREFIXES).toEqual({ 'opencode:': 'opencode', 'codex:': 'codex' });
	});
});

describe('resolveBoundSession', () => {
	it('opencode:<id> routes to the opencode-type driver and returns its binding', () => {
		const opencode = agent({
			type: 'opencode',
			uid: 7,
			resolve: (id) => (id === 'ses_x' ? { aiclawUid: 7, roomId: 42 } : undefined),
		});
		const out = resolveBoundSession('opencode:ses_x', [opencode]);
		expect(out).toEqual({ aiclawUid: 7, roomId: 42, apiClient: opencode.api });
	});

	it('routes by prefix even when another driver could also resolve the id', () => {
		// a non-opencode driver that would resolve the id if asked — it must NOT be consulted
		const wrong = agent({ type: 'openclaw', uid: 1, resolve: () => ({ aiclawUid: 1, roomId: 1 }) });
		const opencode = agent({ type: 'opencode', uid: 7, resolve: () => ({ aiclawUid: 7, roomId: 42 }) });
		const out = resolveBoundSession('opencode:ses_x', [wrong, opencode]);
		expect(out).toEqual({ aiclawUid: 7, roomId: 42, apiClient: opencode.api });
	});

	it('owner api is the agent whose uid the driver resolved to (not the resolving driver)', () => {
		// opencode driver resolves to uid 9; the api returned must be uid-9's api
		const opencode = agent({ type: 'opencode', uid: 7, resolve: () => ({ aiclawUid: 9, roomId: 5 }) });
		const owner = agent({ type: 'openclaw', uid: 9 });
		const out = resolveBoundSession('opencode:ses_x', [opencode, owner]);
		expect(out).toEqual({ aiclawUid: 9, roomId: 5, apiClient: owner.api });
	});

	it('codex:<id> with no codex driver present → undefined', () => {
		const opencode = agent({ type: 'opencode', uid: 7, resolve: () => ({ aiclawUid: 7, roomId: 42 }) });
		expect(resolveBoundSession('codex:thr_y', [opencode])).toBeUndefined();
	});

	it('unprefixed key → undefined', () => {
		const opencode = agent({ type: 'opencode', uid: 7, resolve: () => ({ aiclawUid: 7, roomId: 42 }) });
		expect(resolveBoundSession('ses_x', [opencode])).toBeUndefined();
	});

	it('matching-type driver lacks resolveSession → undefined', () => {
		const opencode = agent({ type: 'opencode', uid: 7 }); // no resolve
		expect(resolveBoundSession('opencode:ses_x', [opencode])).toBeUndefined();
	});

	it('matching-type driver returns undefined for the id → undefined', () => {
		const opencode = agent({ type: 'opencode', uid: 7, resolve: () => undefined });
		expect(resolveBoundSession('opencode:ses_x', [opencode])).toBeUndefined();
	});
});
