import { describe, expect, it } from 'vitest';
import { AncestorChain } from './ancestor-chain.js';

const T0 = 1_000_000;
const user = (id: string, created = T0 + 1) => ({ id, role: 'user', timeCreated: created });
const assistant = (id: string, parentID?: string, created = T0 + 2) =>
	({ id, role: 'assistant', ...(parentID === undefined ? {} : { parentID }), timeCreated: created });
const tool = (callID: string, messageID: string) => ({ callID, messageID });

describe('AncestorChain', () => {
	it('verifies a clean user → assistant → tool chain', () => {
		const chain = new AncestorChain(T0);
		chain.observeMessageUpdated(user('U1'));
		chain.observeMessageUpdated(assistant('A1', 'U1'));
		chain.observeToolPart(tool('c1', 'A1'));
		chain.observeToolPart(tool('c2', 'A1'));
		expect(chain.verifyCompletion({ id: 'A1', parentID: 'U1' })).toEqual({ ok: true, userMessageID: 'U1' });
		const record = chain.record(true);
		expect(record).toMatchObject({ assistants: 1, toolCalls: 2, verified: true });
		expect(JSON.stringify(record)).not.toContain('U1');
		expect(JSON.stringify(record)).not.toContain('c1');
	});

	it('ignores stale replayed history from before the run', () => {
		const chain = new AncestorChain(T0);
		chain.observeMessageUpdated(user('U-old', T0 - 10_000));
		chain.observeMessageUpdated(assistant('A-old', 'U-old', T0 - 9_000));
		chain.observeMessageUpdated(user('U1'));
		chain.observeMessageUpdated(assistant('A1', 'U1'));
		expect(chain.verifyCompletion({ id: 'A1', parentID: 'U1' })).toEqual({ ok: true, userMessageID: 'U1' });
	});

	it('conflicts on a second fresh user message (never guesses current/latest)', () => {
		const chain = new AncestorChain(T0);
		chain.observeMessageUpdated(user('U1'));
		chain.observeMessageUpdated(user('U2'));
		const verdict = chain.verifyCompletion({ id: 'A2', parentID: 'U2' });
		expect(verdict).toMatchObject({ ok: false, reason: 'conflict' });
		expect(chain.record(false).conflict).toContain('multiple-user-messages');
	});

	it('conflicts when the completion parent disagrees with the observed user', () => {
		const chain = new AncestorChain(T0);
		chain.observeMessageUpdated(user('U1'));
		chain.observeMessageUpdated(assistant('A9', 'U9'));
		expect(chain.verifyCompletion({ id: 'A9', parentID: 'U9' })).toMatchObject({ ok: false, reason: 'conflict' });
	});

	it('conflicts when a tool resolves to a foreign ancestor', () => {
		const chain = new AncestorChain(T0);
		chain.observeMessageUpdated(user('U1'));
		chain.observeMessageUpdated(assistant('A1', 'U1'));
		chain.observeMessageUpdated(assistant('AX', 'UX'));
		chain.observeToolPart(tool('cX', 'AX'));
		const verdict = chain.verifyCompletion({ id: 'A1', parentID: 'U1' });
		expect(verdict).toMatchObject({ ok: false, reason: 'conflict' });
	});

	it('conflicts when one callID is reused across messages', () => {
		const chain = new AncestorChain(T0);
		chain.observeMessageUpdated(user('U1'));
		chain.observeMessageUpdated(assistant('A1', 'U1'));
		chain.observeMessageUpdated(assistant('A2', 'U1'));
		chain.observeToolPart(tool('c1', 'A1'));
		chain.observeToolPart(tool('c1', 'A2'));
		expect(chain.verifyCompletion({ id: 'A2', parentID: 'U1' })).toMatchObject({ ok: false, reason: 'conflict' });
	});

	it('stays unverified (not failed) when proof is missing', () => {
		const noUser = new AncestorChain(T0);
		noUser.observeMessageUpdated(assistant('A1', 'U1'));
		expect(noUser.verifyCompletion({ id: 'A1', parentID: 'U1' }))
			.toEqual({ ok: false, reason: 'unverified', detail: 'no-user-message-observed' });

		const unannounced = new AncestorChain(T0);
		unannounced.observeMessageUpdated(user('U1'));
		unannounced.observeMessageUpdated(assistant('A1', 'U1'));
		unannounced.observeToolPart(tool('c9', 'A9'));
		expect(unannounced.verifyCompletion({ id: 'A1', parentID: 'U1' }))
			.toMatchObject({ ok: false, reason: 'unverified' });

		const noParent = new AncestorChain(T0);
		noParent.observeMessageUpdated(user('U1'));
		expect(noParent.verifyCompletion({ id: 'A1' })).toMatchObject({ ok: false, reason: 'unverified' });
	});

	it('ignores malformed observations without failing', () => {
		const chain = new AncestorChain(T0);
		chain.observeMessageUpdated({});
		chain.observeMessageUpdated({ id: '', role: 'user' });
		chain.observeToolPart({});
		chain.observeMessageUpdated(user('U1'));
		expect(chain.verifyCompletion({ id: 'A1', parentID: 'U1' })).toEqual({ ok: true, userMessageID: 'U1' });
	});
});
