import { describe, it, expect } from 'vitest';
import { mapOpencodeEvent } from './events.js';

const SID = 'ses_abc';

describe('mapOpencodeEvent', () => {
	it('text part with delta → thinking (prefers delta)', () => {
		const evt = {
			type: 'message.part.updated',
			properties: { part: { type: 'text', sessionID: SID, text: 'full text' }, delta: 'chunk' },
		};
		expect(mapOpencodeEvent(evt, SID)).toEqual({ type: 'thinking', text: 'chunk' });
	});

	it('text part without delta → thinking falls back to part.text', () => {
		const evt = {
			type: 'message.part.updated',
			properties: { part: { type: 'text', sessionID: SID, text: 'hello' } },
		};
		expect(mapOpencodeEvent(evt, SID)).toEqual({ type: 'thinking', text: 'hello' });
	});

	it('reasoning part → thinking', () => {
		const evt = {
			type: 'message.part.updated',
			properties: { part: { type: 'reasoning', sessionID: SID, text: 'thinking aloud' } },
		};
		expect(mapOpencodeEvent(evt, SID)).toEqual({ type: 'thinking', text: 'thinking aloud' });
	});

	it('tool part running → tool start', () => {
		const evt = {
			type: 'message.part.updated',
			properties: { part: { type: 'tool', sessionID: SID, tool: 'bash', callID: 'c1', state: { status: 'running' } } },
		};
		expect(mapOpencodeEvent(evt, SID)).toEqual({ type: 'tool', name: 'bash', phase: 'start' });
	});

	it('tool part pending → tool start', () => {
		const evt = {
			type: 'message.part.updated',
			properties: { part: { type: 'tool', sessionID: SID, tool: 'read', callID: 'c2', state: { status: 'pending' } } },
		};
		expect(mapOpencodeEvent(evt, SID)).toEqual({ type: 'tool', name: 'read', phase: 'start' });
	});

	it('tool part completed → tool end', () => {
		const evt = {
			type: 'message.part.updated',
			properties: { part: { type: 'tool', sessionID: SID, tool: 'bash', callID: 'c1', state: { status: 'completed' } } },
		};
		expect(mapOpencodeEvent(evt, SID)).toEqual({ type: 'tool', name: 'bash', phase: 'end' });
	});

	it('tool part error → tool end', () => {
		const evt = {
			type: 'message.part.updated',
			properties: { part: { type: 'tool', sessionID: SID, tool: 'bash', callID: 'c1', state: { status: 'error' } } },
		};
		expect(mapOpencodeEvent(evt, SID)).toEqual({ type: 'tool', name: 'bash', phase: 'end' });
	});

	it('session.idle for matching session → done with durationMs:0 (session fills real value)', () => {
		const evt = { type: 'session.idle', properties: { sessionID: SID } };
		expect(mapOpencodeEvent(evt, SID)).toEqual({ type: 'done', durationMs: 0 });
	});

	it('session.error → error (stringified)', () => {
		const evt = {
			type: 'session.error',
			properties: { sessionID: SID, error: { name: 'UnknownError', data: { message: 'boom' } } },
		};
		expect(mapOpencodeEvent(evt, SID)).toEqual({ type: 'error', message: 'UnknownError: boom' });
	});

	it('session.error with no sessionID still maps (id absent → not filtered)', () => {
		const evt = { type: 'session.error', properties: { error: 'plain string error' } };
		expect(mapOpencodeEvent(evt, SID)).toEqual({ type: 'error', message: 'plain string error' });
	});

	it('event for a DIFFERENT sessionID → null', () => {
		const evt = {
			type: 'message.part.updated',
			properties: { part: { type: 'text', sessionID: 'other_session', text: 'x' } },
		};
		expect(mapOpencodeEvent(evt, SID)).toBeNull();
	});

	it('session.idle for a different session → null', () => {
		const evt = { type: 'session.idle', properties: { sessionID: 'other_session' } };
		expect(mapOpencodeEvent(evt, SID)).toBeNull();
	});

	it('unrelated event type → null', () => {
		expect(mapOpencodeEvent({ type: 'file.edited', properties: {} }, SID)).toBeNull();
	});

	it('ignored part types (step-start/snapshot/...) → null', () => {
		const evt = {
			type: 'message.part.updated',
			properties: { part: { type: 'step-start', sessionID: SID } },
		};
		expect(mapOpencodeEvent(evt, SID)).toBeNull();
	});

	it('non-object / malformed input → null', () => {
		expect(mapOpencodeEvent(null, SID)).toBeNull();
		expect(mapOpencodeEvent(undefined, SID)).toBeNull();
		expect(mapOpencodeEvent({ noType: true }, SID)).toBeNull();
	});
});
