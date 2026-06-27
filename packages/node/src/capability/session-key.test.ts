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

	it('openclaw:<binding> → { agentType: openclaw, id: <binding> } (REQ-010 S6 Phase-2)', () => {
		expect(parseSessionKey('openclaw:aiclaw-1-room-2')).toEqual({
			agentType: 'openclaw',
			id: 'aiclaw-1-room-2',
		});
	});

	it('cc:<binding> → { agentType: cc, id: <binding> } (REQ-010 S7)', () => {
		expect(parseSessionKey('cc:aiclaw-3-room-4')).toEqual({
			agentType: 'cc',
			id: 'aiclaw-3-room-4',
		});
	});

	it('KNOWN_PREFIXES maps prefixes to AgentDriver.type', () => {
		expect(KNOWN_PREFIXES).toEqual({
			'opencode:': 'opencode',
			'codex:': 'codex',
			'openclaw:': 'openclaw',
			'cc:': 'cc',
		});
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

	it('openclaw:<binding> routes to the openclaw driver with the prefix STRIPPED (id = bare binding)', () => {
		// resolveBoundSession must hand the openclaw driver the prefix-stripped id (the bare binding),
		// exactly like opencode/codex — assert it sees `aiclaw-3-room-8`, not `openclaw:aiclaw-3-room-8`.
		let seenId: string | undefined;
		const openclaw = agent({
			type: 'openclaw',
			uid: 3,
			resolve: (id) => {
				seenId = id;
				return id === 'aiclaw-3-room-8' ? { aiclawUid: 3, roomId: 8 } : undefined;
			},
		});
		const out = resolveBoundSession('openclaw:aiclaw-3-room-8', [openclaw]);
		expect(seenId).toBe('aiclaw-3-room-8');
		expect(out).toEqual({ aiclawUid: 3, roomId: 8, apiClient: openclaw.api });
	});

	it('cc:<binding> routes to the cc driver with the prefix STRIPPED (id = bare binding)', () => {
		// REQ-010 S7: same contract as openclaw — the cc driver must see the bare binding, not `cc:…`.
		let seenId: string | undefined;
		const cc = agent({
			type: 'cc',
			uid: 5,
			resolve: (id) => {
				seenId = id;
				return id === 'aiclaw-5-room-9' ? { aiclawUid: 5, roomId: 9 } : undefined;
			},
		});
		const out = resolveBoundSession('cc:aiclaw-5-room-9', [cc]);
		expect(seenId).toBe('aiclaw-5-room-9');
		expect(out).toEqual({ aiclawUid: 5, roomId: 9, apiClient: cc.api });
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
