import { describe, it, expect } from 'vitest';
import { mapOpencodeEvent } from './events.js';

const SID = 'ses_abc';
/** Assistant message ids the caller whitelisted from `message.updated` events. */
const ASSISTANT = new Set(['msg_asst']);

describe('mapOpencodeEvent', () => {
	it('text part with delta → thinking (prefers delta)', () => {
		const evt = {
			type: 'message.part.updated',
			properties: { part: { type: 'text', sessionID: SID, messageID: 'msg_asst', text: 'full text' }, delta: 'chunk' },
		};
		expect(mapOpencodeEvent(evt, SID, ASSISTANT)).toEqual({ type: 'thinking', text: 'chunk' });
	});

	it('text part without delta → thinking falls back to part.text', () => {
		const evt = {
			type: 'message.part.updated',
			properties: { part: { type: 'text', sessionID: SID, messageID: 'msg_asst', text: 'hello' } },
		};
		expect(mapOpencodeEvent(evt, SID, ASSISTANT)).toEqual({ type: 'thinking', text: 'hello' });
	});

	it('reasoning part → thinking', () => {
		const evt = {
			type: 'message.part.updated',
			properties: { part: { type: 'reasoning', sessionID: SID, messageID: 'msg_asst', text: 'thinking aloud' } },
		};
		expect(mapOpencodeEvent(evt, SID, ASSISTANT)).toEqual({ type: 'thinking', text: 'thinking aloud' });
	});

	// opencode emits a `text` part for the USER message too (the prompt we sent, including the
	// reply-instruction envelope). Parts carry no role — only sessionID/messageID — so a text
	// part whose messageID was NOT whitelisted as an assistant message must NOT become thinking.
	it('text part of a USER message (messageID not whitelisted) → null (no prompt leak)', () => {
		const evt = {
			type: 'message.part.updated',
			properties: { part: { type: 'text', sessionID: SID, messageID: 'msg_user', text: 'the full prompt' } },
		};
		expect(mapOpencodeEvent(evt, SID, ASSISTANT)).toBeNull();
	});

	it('text part with NO messageID → null (cannot prove assistant origin)', () => {
		const evt = {
			type: 'message.part.updated',
			properties: { part: { type: 'text', sessionID: SID, text: 'orphan text' } },
		};
		expect(mapOpencodeEvent(evt, SID, ASSISTANT)).toBeNull();
	});

	it('reasoning part of a USER message (messageID not whitelisted) → null', () => {
		const evt = {
			type: 'message.part.updated',
			properties: { part: { type: 'reasoning', sessionID: SID, messageID: 'msg_user', text: 'x' } },
		};
		expect(mapOpencodeEvent(evt, SID, ASSISTANT)).toBeNull();
	});

	it('tool part running → tool start (no messageID gate: user messages never carry tool parts)', () => {
		const evt = {
			type: 'message.part.updated',
			properties: { part: { type: 'tool', sessionID: SID, tool: 'bash', callID: 'c1', state: { status: 'running' } } },
		};
		expect(mapOpencodeEvent(evt, SID, ASSISTANT)).toEqual({ type: 'tool', name: 'bash', phase: 'start' });
	});

	it('tool part pending → tool start', () => {
		const evt = {
			type: 'message.part.updated',
			properties: { part: { type: 'tool', sessionID: SID, tool: 'read', callID: 'c2', state: { status: 'pending' } } },
		};
		expect(mapOpencodeEvent(evt, SID, ASSISTANT)).toEqual({ type: 'tool', name: 'read', phase: 'start' });
	});

	it('tool part completed → tool end', () => {
		const evt = {
			type: 'message.part.updated',
			properties: { part: { type: 'tool', sessionID: SID, tool: 'bash', callID: 'c1', state: { status: 'completed' } } },
		};
		expect(mapOpencodeEvent(evt, SID, ASSISTANT)).toEqual({ type: 'tool', name: 'bash', phase: 'end' });
	});

	it('tool part error → tool end', () => {
		const evt = {
			type: 'message.part.updated',
			properties: { part: { type: 'tool', sessionID: SID, tool: 'bash', callID: 'c1', state: { status: 'error' } } },
		};
		expect(mapOpencodeEvent(evt, SID, ASSISTANT)).toEqual({ type: 'tool', name: 'bash', phase: 'end' });
	});

	// REQ-010 S1: the terminal-tool reply path is retired. The agent replies out-of-band via
	// `aichat send-message`, so hula_* tools no longer exist and ALL completed tools map to a
	// generic tool end (no special terminal detection).
	it('a completed tool is a tool end (no special terminal detection)', () => {
		const evt = {
			type: 'message.part.updated',
			properties: { part: { type: 'tool', sessionID: SID, tool: 'read', callID: 'c1', state: { status: 'completed', input: { content: 'not a reply' } } } },
		};
		expect(mapOpencodeEvent(evt, SID, ASSISTANT)).toEqual({ type: 'tool', name: 'read', phase: 'end' });
	});

	it('a running bash tool → tool start (generic mapping intact)', () => {
		const evt = {
			type: 'message.part.updated',
			properties: { part: { type: 'tool', sessionID: SID, tool: 'bash', callID: 'c9', state: { status: 'running' } } },
		};
		expect(mapOpencodeEvent(evt, SID, ASSISTANT)).toEqual({ type: 'tool', name: 'bash', phase: 'start' });
	});

	it('session.idle for matching session → done with durationMs:0 (session fills real value)', () => {
		const evt = { type: 'session.idle', properties: { sessionID: SID } };
		expect(mapOpencodeEvent(evt, SID, ASSISTANT)).toEqual({ type: 'done', durationMs: 0 });
	});

	it('session.error → error (stringified)', () => {
		const evt = {
			type: 'session.error',
			properties: { sessionID: SID, error: { name: 'UnknownError', data: { message: 'boom' } } },
		};
		expect(mapOpencodeEvent(evt, SID, ASSISTANT)).toEqual({ type: 'error', message: 'UnknownError: boom' });
	});

	it('session.error with no sessionID still maps (id absent → not filtered)', () => {
		const evt = { type: 'session.error', properties: { error: 'plain string error' } };
		expect(mapOpencodeEvent(evt, SID, ASSISTANT)).toEqual({ type: 'error', message: 'plain string error' });
	});

	// aichatoverview#256 — serve reports provider rate-limit/backoff via session.status=retry.
	// It MUST become a terminal error carrying the serve reason, not fall to default (null) —
	// otherwise the driver waits forever and the handler's 300s timeout masks the real cause.
	// Golden shape = tester-captured v1.18.16 (aichatoverview#259): reason lives at
	// status.action.reason (NOT status.reason). Full stream at tests/desktop/reports/opencode-256-replay.mjs.
	it('session.status retry with action.reason (golden, tester-captured) → error with reason suffix', () => {
		const evt = {
			type: 'session.status',
			properties: {
				sessionID: SID,
				status: { type: 'retry', attempt: 1, message: 'Free usage exceeded', next: 30_000, action: { reason: 'free_tier_limit' } },
			},
		};
		expect(mapOpencodeEvent(evt, SID, ASSISTANT)).toEqual({
			type: 'error',
			message: 'opencode retry: Free usage exceeded (free_tier_limit)',
		});
	});

	it('session.status retry with legacy status.reason → still maps (compat)', () => {
		const evt = {
			type: 'session.status',
			properties: { sessionID: SID, status: { type: 'retry', attempt: 1, message: 'x', next: 30_000, reason: 'free_tier_limit' } },
		};
		expect(mapOpencodeEvent(evt, SID, ASSISTANT)).toEqual({ type: 'error', message: 'opencode retry: x (free_tier_limit)' });
	});

	it('session.status retry with message only → error carries it', () => {
		const evt = {
			type: 'session.status',
			properties: { sessionID: SID, status: { type: 'retry', attempt: 2, message: 'provider rate limit', next: 60_000 } },
		};
		expect(mapOpencodeEvent(evt, SID, ASSISTANT)).toEqual({ type: 'error', message: 'opencode retry: provider rate limit' });
	});

	it('session.status retry with no message/reason → error with generic reason', () => {
		const evt = {
			type: 'session.status',
			properties: { sessionID: SID, status: { type: 'retry', attempt: 1, next: 30_000 } },
		};
		expect(mapOpencodeEvent(evt, SID, ASSISTANT)).toEqual({ type: 'error', message: 'opencode retry: rate limited' });
	});

	it('session.status busy → null (still working, ignore)', () => {
		const evt = {
			type: 'session.status',
			properties: { sessionID: SID, status: { type: 'busy' } },
		};
		expect(mapOpencodeEvent(evt, SID, ASSISTANT)).toBeNull();
	});

	it('session.status retry for a DIFFERENT session → null', () => {
		const evt = {
			type: 'session.status',
			properties: { sessionID: 'other_session', status: { type: 'retry', attempt: 1, message: 'x', next: 30_000 } },
		};
		expect(mapOpencodeEvent(evt, SID, ASSISTANT)).toBeNull();
	});

	// aichatoverview#258 — serve emits permission.asked (runtime v1.18.16) when a tool asks for a
	// permission (e.g. external_directory for out-of-workspace access). Headless deploy has nobody to
	// approve, so the session stalls until the handler's 300s timeout — surface it as a TERMINAL error
	// instead. (In-workspace actions are auto-allowed in the deployed mode, so only real asks fire.)
	// Golden fixture = TESTER-CAPTURED real frame (Windows 11 + opencode 1.18.16, verbatim;
	// full stream at tests/desktop/reports/opencode-258-sse-permission.log), sessionID → SID.
	it('permission.asked (golden, tester-captured v1.18.16) → error with permission + target path', () => {
		const evt = {
			id: 'evt_ff1bd4e85001PI06sc3sJs49TI',
			type: 'permission.asked',
			properties: {
				id: 'per_ff1bd4e84001NJrR6iITdxbb0R',
				sessionID: SID,
				permission: 'external_directory',
				patterns: ['C:\\Windows\\*'],
				metadata: { filepath: 'C:\\Windows\\win.ini', parentDir: 'C:\\Windows' },
				always: ['C:\\Windows\\*'],
				tool: { messageID: 'msg_ff1bd24040015BwUocAvOUD9nK', callID: 'call_00_Y2jUEQdUWj8loODiVsjI6413' },
			},
		};
		expect(mapOpencodeEvent(evt, SID, ASSISTANT)).toEqual({
			type: 'error',
			message: 'opencode requested permission: external_directory (C:\\Windows\\win.ini) — headless cannot approve',
		});
	});

	it('permission.asked with empty patterns → error with permission only', () => {
		const evt = {
			type: 'permission.asked',
			properties: { id: 'req_2', sessionID: SID, permission: 'web', patterns: [], metadata: {}, always: [] },
		};
		expect(mapOpencodeEvent(evt, SID, ASSISTANT)).toEqual({
			type: 'error',
			message: 'opencode requested permission: web — headless cannot approve',
		});
	});

	it('permission.asked for a DIFFERENT session → null', () => {
		const evt = {
			type: 'permission.asked',
			properties: { id: 'req_3', sessionID: 'other_session', permission: 'web', patterns: [], metadata: {}, always: [] },
		};
		expect(mapOpencodeEvent(evt, SID, ASSISTANT)).toBeNull();
	});

	// legacy 1.17.9 serve emits permission.updated with the OLD shape {type, pattern, title} — keep
	// dual-name matching (same defensive posture as #256) and fall back to the old field names.
	it('legacy permission.updated → error via old shape (type/pattern/title)', () => {
		const evt = {
			type: 'permission.updated',
			properties: { id: 'perm_1', type: 'external_directory', pattern: '/home/user', sessionID: SID, messageID: 'm', title: 'Access outside workspace' },
		};
		expect(mapOpencodeEvent(evt, SID, ASSISTANT)).toEqual({
			type: 'error',
			message: 'opencode requested permission: external_directory (/home/user) — headless cannot approve',
		});
	});

	it('event for a DIFFERENT sessionID → null', () => {
		const evt = {
			type: 'message.part.updated',
			properties: { part: { type: 'text', sessionID: 'other_session', messageID: 'msg_asst', text: 'x' } },
		};
		expect(mapOpencodeEvent(evt, SID, ASSISTANT)).toBeNull();
	});

	it('session.idle for a different session → null', () => {
		const evt = { type: 'session.idle', properties: { sessionID: 'other_session' } };
		expect(mapOpencodeEvent(evt, SID, ASSISTANT)).toBeNull();
	});

	it('unrelated event type → null', () => {
		expect(mapOpencodeEvent({ type: 'file.edited', properties: {} }, SID, ASSISTANT)).toBeNull();
	});

	it('message.updated events fall through to null (the CALLER whitelists from them)', () => {
		const evt = {
			type: 'message.updated',
			properties: { info: { id: 'msg_asst', sessionID: SID, role: 'assistant' } },
		};
		expect(mapOpencodeEvent(evt, SID, ASSISTANT)).toBeNull();
	});

	it('ignored part types (step-start/snapshot/...) → null', () => {
		const evt = {
			type: 'message.part.updated',
			properties: { part: { type: 'step-start', sessionID: SID } },
		};
		expect(mapOpencodeEvent(evt, SID, ASSISTANT)).toBeNull();
	});

	it('non-object / malformed input → null', () => {
		expect(mapOpencodeEvent(null, SID, ASSISTANT)).toBeNull();
		expect(mapOpencodeEvent(undefined, SID, ASSISTANT)).toBeNull();
		expect(mapOpencodeEvent({ noType: true }, SID, ASSISTANT)).toBeNull();
	});
});
