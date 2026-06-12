import { describe, it, expect } from 'vitest';
import { parseSessionKey } from './session-key.js';

describe('parseSessionKey', () => {
	it('parses a bare sessionKey aiclaw-{uid}-room-{roomId}', () => {
		expect(parseSessionKey('aiclaw-100-room-1')).toEqual({
			aiclawUid: '100',
			roomId: '1',
		});
	});

	it('tolerates openclaw-normalized agent:main: prefix', () => {
		// spike #2: openclaw 把 sessionKey 规范化为 agent:main:aiclaw-100-room-1
		expect(parseSessionKey('agent:main:aiclaw-100-room-1')).toEqual({
			aiclawUid: '100',
			roomId: '1',
		});
	});

	it('keeps large snowflake IDs as strings (no precision loss)', () => {
		// 雪花 ID 超过 Number.MAX_SAFE_INTEGER，必须保留字符串
		const uid = '10937855681024';
		const roomId = '163347643904512';
		expect(parseSessionKey(`aiclaw-${uid}-room-${roomId}`)).toEqual({
			aiclawUid: uid,
			roomId,
		});
	});

	it('returns null for null/undefined/empty input', () => {
		expect(parseSessionKey(null)).toBeNull();
		expect(parseSessionKey(undefined)).toBeNull();
		expect(parseSessionKey('')).toBeNull();
	});

	it('returns null when the aiclaw prefix is missing', () => {
		expect(parseSessionKey('foo-100-room-1')).toBeNull();
		expect(parseSessionKey('100-room-1')).toBeNull();
	});

	it('returns null when the -room- segment is missing', () => {
		expect(parseSessionKey('aiclaw-100-1')).toBeNull();
		expect(parseSessionKey('aiclaw-100')).toBeNull();
	});

	it('returns null when uid or roomId is non-numeric', () => {
		expect(parseSessionKey('aiclaw-abc-room-1')).toBeNull();
		expect(parseSessionKey('aiclaw-100-room-xyz')).toBeNull();
	});

	it('returns null when uid or roomId is empty', () => {
		expect(parseSessionKey('aiclaw--room-1')).toBeNull();
		expect(parseSessionKey('aiclaw-100-room-')).toBeNull();
	});

	it('requires aiclaw at a segment boundary (no partial-word match)', () => {
		// 前缀必须是 aiclaw 本身，不能是 xxxaiclaw 这种粘连词
		expect(parseSessionKey('notaiclaw-100-room-1')).toBeNull();
	});
});
