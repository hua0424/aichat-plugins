import { describe, it, expect } from 'vitest';
import { parseSessionKey, KNOWN_PREFIXES } from './session-key.js';

describe('parseSessionKey', () => {
	it('opencode:ses_x → { agentType: opencode, id: ses_x }', () => {
		expect(parseSessionKey('opencode:ses_x')).toEqual({ agentType: 'opencode', id: 'ses_x' });
	});
	it('codex:thr_y → { agentType: codex, id: thr_y }', () => {
		expect(parseSessionKey('codex:thr_y')).toEqual({ agentType: 'codex', id: 'thr_y' });
	});
	it('unprefixed, unknown prefix, and empty id are rejected', () => {
		expect(parseSessionKey('ses_x')).toBeUndefined();
		expect(parseSessionKey('foo:bar')).toBeUndefined();
		expect(parseSessionKey('opencode:')).toBeUndefined();
	});
	it('openclaw and cc prefixes preserve opaque IDs', () => {
		expect(parseSessionKey('openclaw:aiclaw-1-room-2')).toEqual({ agentType: 'openclaw', id: 'aiclaw-1-room-2' });
		expect(parseSessionKey('cc:aiclaw-3-room-4')).toEqual({ agentType: 'cc', id: 'aiclaw-3-room-4' });
	});
	it('KNOWN_PREFIXES maps prefixes to native driver types', () => {
		expect(KNOWN_PREFIXES).toEqual({ 'opencode:': 'opencode', 'codex:': 'codex', 'openclaw:': 'openclaw', 'cc:': 'cc' });
	});
});
