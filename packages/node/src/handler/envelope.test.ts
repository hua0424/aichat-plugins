import { describe, it, expect } from 'vitest';
import { buildAgentEnvelope } from './envelope.js';

// REQ-013 S1 (AC7): the unified inbound-attribution envelope shared by ALL FOUR drivers. This is now
// the single source of the format (the cc driver no longer builds it itself). REQ-029: uids are opaque
// strings, never Number().
// REQ-018: the #188 人设 block is RETIRED — persona now lives in each driver's system layer
// (rendered from server-fetched templates). buildAgentEnvelope is PURE data (room header + attributed
// lines) and never emits a 人设 block.
describe('buildAgentEnvelope — unified inbound-attribution envelope (REQ-013 S1)', () => {
	it('group with accumulated lines → `[HuLa 群聊]\\n<acc>\\n[name(uid)]: cur`', () => {
		const accumulated = ['[alice(100)]: first', '[bob(101)]: second'];
		expect(
			buildAgentEnvelope({ roomType: 1, fromName: 'dave', fromUid: '102', accumulated, message: 'hey bot' }),
		).toBe('[HuLa 群聊]\n[alice(100)]: first\n[bob(101)]: second\n[dave(102)]: hey bot');
	});

	it('group with EMPTY accumulated → `[HuLa 群聊]\\n[name(uid)]: cur`', () => {
		expect(
			buildAgentEnvelope({ roomType: 1, fromName: 'dave', fromUid: '102', accumulated: [], message: 'hey bot' }),
		).toBe('[HuLa 群聊]\n[dave(102)]: hey bot');
	});

	it('DM (roomType===2) → `[HuLa 私聊]\\n[name(uid)]: cur` (accumulated ignored/empty in DM)', () => {
		expect(
			buildAgentEnvelope({ roomType: 2, fromName: '小明', fromUid: '100', accumulated: [], message: '你好' }),
		).toBe('[HuLa 私聊]\n[小明(100)]: 你好');
	});

	it('unknown/other roomType (1 or 0) → group header (else-branch)', () => {
		expect(buildAgentEnvelope({ roomType: 1, fromName: 'x', fromUid: '1', accumulated: [], message: 'a' })).toBe(
			'[HuLa 群聊]\n[x(1)]: a',
		);
		expect(buildAgentEnvelope({ roomType: 0, fromName: 'x', fromUid: '1', accumulated: [], message: 'a' })).toBe(
			'[HuLa 群聊]\n[x(1)]: a',
		);
	});

	it('edge: empty/unknown fromName still renders without throwing', () => {
		expect(buildAgentEnvelope({ roomType: 1, fromName: '', fromUid: '7', accumulated: [], message: 'm' })).toBe(
			'[HuLa 群聊]\n[(7)]: m',
		);
		expect(
			buildAgentEnvelope({ roomType: 2, fromName: 'unknown', fromUid: '7', accumulated: [], message: 'm' }),
		).toBe('[HuLa 私聊]\n[unknown(7)]: m');
	});

	it('REQ-018: never emits a 人设 block (persona moved to the system layer)', () => {
		expect(
			buildAgentEnvelope({ roomType: 2, fromName: '小明', fromUid: '100', accumulated: [], message: '你好' }),
		).toBe('[HuLa 私聊]\n[小明(100)]: 你好');
		expect(
			buildAgentEnvelope({ roomType: 1, fromName: 'dave', fromUid: '102', accumulated: ['[alice(100)]: first'], message: 'hey' }),
		).not.toContain('人设');
	});

	it('REQ-029: a >2^53 fromUid is rendered as its EXACT string (never Number())', () => {
		expect(
			buildAgentEnvelope({
				roomType: 2,
				fromName: 'big',
				fromUid: '9007199254740993',
				accumulated: [],
				message: 'hi',
			}),
		).toBe('[HuLa 私聊]\n[big(9007199254740993)]: hi');
	});
});
