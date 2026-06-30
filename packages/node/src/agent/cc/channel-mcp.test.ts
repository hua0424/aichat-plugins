import { describe, it, expect } from 'vitest';
import { makeChannelNotification, shouldSubscribe } from './channel-mcp.js';

describe('makeChannelNotification', () => {
	it('maps a {type:message, content} frame → a claude/channel notification', () => {
		expect(makeChannelNotification({ type: 'message', content: 'hi' })).toEqual({
			method: 'notifications/claude/channel',
			params: { content: 'hi' },
		});
	});

	it('includes meta when the frame carries it', () => {
		expect(makeChannelNotification({ type: 'message', content: 'hi', meta: { fromUid: 5 } })).toEqual({
			method: 'notifications/claude/channel',
			params: { content: 'hi', meta: { fromUid: 5 } },
		});
	});

	it('returns undefined for a message frame missing content', () => {
		expect(makeChannelNotification({ type: 'message' })).toBeUndefined();
	});

	it('returns undefined for a non-message frame', () => {
		expect(makeChannelNotification({ type: 'other', content: 'x' })).toBeUndefined();
	});

	it('returns undefined for garbage', () => {
		expect(makeChannelNotification('nope')).toBeUndefined();
		expect(makeChannelNotification(null)).toBeUndefined();
		expect(makeChannelNotification(42)).toBeUndefined();
	});
});

describe('shouldSubscribe', () => {
	it('returns undefined when AICHAT_BIND is absent (never subscribe in a non-CC session)', () => {
		expect(shouldSubscribe({})).toBeUndefined();
	});

	it('returns the binding when AICHAT_BIND is a non-empty string', () => {
		expect(shouldSubscribe({ AICHAT_BIND: 'aiclaw-9-room-7' })).toBe('aiclaw-9-room-7');
	});

	it('returns undefined when AICHAT_BIND is empty', () => {
		expect(shouldSubscribe({ AICHAT_BIND: '' })).toBeUndefined();
	});
});
