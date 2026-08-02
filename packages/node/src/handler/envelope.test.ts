import { describe, it, expect } from 'vitest';
import { buildAgentEnvelope } from './envelope.js';

// REQ-013 S1 (AC7): the unified inbound-attribution envelope shared by ALL FOUR drivers. This is now
// the single source of the format (the cc driver no longer builds it itself). REQ-029: uids are opaque
// strings, never Number().
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

	it('#188: persona injected BEFORE the room header, original envelope byte-identical after it', () => {
		expect(
			buildAgentEnvelope({
				roomType: 2,
				fromName: '小明',
				fromUid: '100',
				accumulated: [],
				message: '你好',
				persona: '你是一个暴躁的猫娘',
			}),
		).toBe('[HuLa 人设开始]\n你是一个暴躁的猫娘\n[HuLa 人设结束]\n[HuLa 私聊]\n[小明(100)]: 你好');
	});

	it('#188: group with persona + accumulated → persona block first, transcript unchanged after', () => {
		const accumulated = ['[alice(100)]: first', '[bob(101)]: second'];
		expect(
			buildAgentEnvelope({
				roomType: 1,
				fromName: 'dave',
				fromUid: '102',
				accumulated,
				message: 'hey bot',
				persona: '多行\n人设\n原文',
			}),
		).toBe(
			'[HuLa 人设开始]\n多行\n人设\n原文\n[HuLa 人设结束]\n[HuLa 群聊]\n[alice(100)]: first\n[bob(101)]: second\n[dave(102)]: hey bot',
		);
	});

	it('#188 (AC6): persona undefined / empty / whitespace-only → output BYTE-IDENTICAL to no persona', () => {
		const base = { roomType: 1, fromName: 'dave', fromUid: '102', accumulated: ['[alice(100)]: first'], message: 'hey' };
		const without = buildAgentEnvelope(base);
		expect(buildAgentEnvelope({ ...base, persona: undefined })).toBe(without);
		expect(buildAgentEnvelope({ ...base, persona: '' })).toBe(without);
		expect(buildAgentEnvelope({ ...base, persona: '   \n\t  ' })).toBe(without);
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
