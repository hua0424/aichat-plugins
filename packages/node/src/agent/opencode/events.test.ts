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

	// REQ-008 #78 — terminal-tool detection (hula_send_message / hula_skip_reply when completed).
	it('completed hula_send_message → terminal sent + content (from state.input.content)', () => {
		const evt = {
			type: 'message.part.updated',
			properties: {
				part: {
					type: 'tool',
					sessionID: SID,
					tool: 'hula_send_message',
					callID: 'c9',
					state: { status: 'completed', input: { content: '你好，我帮你查一下。' } },
				},
			},
		};
		expect(mapOpencodeEvent(evt, SID)).toEqual({ type: 'terminal', action: 'sent', content: '你好，我帮你查一下。' });
	});

	it('completed hula_send_message with no input.content → terminal sent + empty content', () => {
		const evt = {
			type: 'message.part.updated',
			properties: { part: { type: 'tool', sessionID: SID, tool: 'hula_send_message', callID: 'c9', state: { status: 'completed' } } },
		};
		expect(mapOpencodeEvent(evt, SID)).toEqual({ type: 'terminal', action: 'sent', content: '' });
	});

	it('completed hula_skip_reply with reason → terminal skipped + that reason', () => {
		const evt = {
			type: 'message.part.updated',
			properties: {
				part: { type: 'tool', sessionID: SID, tool: 'hula_skip_reply', callID: 'c8', state: { status: 'completed', input: { reason: '纯客套' } } },
			},
		};
		expect(mapOpencodeEvent(evt, SID)).toEqual({ type: 'terminal', action: 'skipped', reason: '纯客套' });
	});

	it('completed hula_skip_reply with no reason → terminal skipped + default reason', () => {
		const evt = {
			type: 'message.part.updated',
			properties: { part: { type: 'tool', sessionID: SID, tool: 'hula_skip_reply', callID: 'c8', state: { status: 'completed' } } },
		};
		expect(mapOpencodeEvent(evt, SID)).toEqual({ type: 'terminal', action: 'skipped', reason: 'agent_skip_reply' });
	});

	// Documented choice: a RUNNING hula_send_message (status!=completed) is NOT terminal — it is
	// treated as an ordinary tool START, consistent with every other tool (we only act on a tool
	// once it has truly completed; we never send a half-formed/aborted reply).
	it('running hula_send_message (not completed) → tool start, NOT terminal', () => {
		const evt = {
			type: 'message.part.updated',
			properties: { part: { type: 'tool', sessionID: SID, tool: 'hula_send_message', callID: 'c9', state: { status: 'running', input: { content: 'x' } } } },
		};
		expect(mapOpencodeEvent(evt, SID)).toEqual({ type: 'tool', name: 'hula_send_message', phase: 'start' });
	});

	it('a NORMAL tool completed is still a tool end (terminal detection only fires for hula_* tools)', () => {
		const evt = {
			type: 'message.part.updated',
			properties: { part: { type: 'tool', sessionID: SID, tool: 'read', callID: 'c1', state: { status: 'completed', input: { content: 'not a reply' } } } },
		};
		expect(mapOpencodeEvent(evt, SID)).toEqual({ type: 'tool', name: 'read', phase: 'end' });
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
