import { describe, it, expect, vi } from 'vitest';
import { CcBroker } from './broker.js';
import { parseCcBinding } from './cc-driver.js';
import { buildCcSink, type CcSinkAgent } from './sink.js';

/** A fake identity: uid + spy external-thinking handler methods, so we can assert by uid. */
function fakeAgent(uid: number): CcSinkAgent & {
	begin: ReturnType<typeof vi.fn>;
	delta: ReturnType<typeof vi.fn>;
	end: ReturnType<typeof vi.fn>;
} {
	const begin = vi.fn();
	const delta = vi.fn();
	const end = vi.fn();
	return {
		uid,
		begin,
		delta,
		end,
		handler: { beginExternalThinking: begin, externalThinkingDelta: delta, endExternalThinking: end },
	};
}

/** Drive a hook through the real broker (resolve = parseCcBinding, sink = buildCcSink). */
function brokerFor(agents: CcSinkAgent[]) {
	return new CcBroker({ resolve: parseCcBinding, sink: buildCcSink(() => agents) });
}

describe('CcBroker → buildCcSink routing by uid (REQ-010 S7)', () => {
	it('UserPromptSubmit → begin on the binding-owner uid only', async () => {
		const a5 = fakeAgent(5);
		const a6 = fakeAgent(6);
		const broker = brokerFor([a5, a6]);

		const res = await broker.handle({
			authToken: 'aiclaw-5-room-42',
			body: { hook_event_name: 'UserPromptSubmit' },
		});
		expect(res.status).toBe(200);
		expect(a5.begin).toHaveBeenCalledWith(42, 5);
		expect(a6.begin).not.toHaveBeenCalled();
	});

	it('PostToolUse → delta on the right uid; Stop → end on the right uid', async () => {
		const a5 = fakeAgent(5);
		const a6 = fakeAgent(6);
		const broker = brokerFor([a5, a6]);

		await broker.handle({
			authToken: 'aiclaw-6-room-9',
			body: { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { cmd: 'ls' } },
		});
		expect(a6.delta).toHaveBeenCalledTimes(1);
		expect(a6.delta.mock.calls[0][0]).toBe(9); // roomId
		expect(a6.delta.mock.calls[0][1]).toBe(6); // uid
		expect(a5.delta).not.toHaveBeenCalled();

		await broker.handle({ authToken: 'aiclaw-6-room-9', body: { hook_event_name: 'Stop' } });
		expect(a6.end).toHaveBeenCalledWith(9, 6);
		expect(a5.end).not.toHaveBeenCalled();
	});

	it('binding whose uid has no live handler → safe no-op (resolve still ok, sink skips)', async () => {
		const a5 = fakeAgent(5);
		const broker = brokerFor([a5]);
		// binding resolves (parse ok) to uid 6 which is not in the agents list → no throw, no dispatch.
		const res = await broker.handle({ authToken: 'aiclaw-6-room-9', body: { hook_event_name: 'UserPromptSubmit' } });
		expect(res.status).toBe(200);
		expect(a5.begin).not.toHaveBeenCalled();
	});

	it('unparseable binding → 401 (resolve undefined), nothing dispatched', async () => {
		const a5 = fakeAgent(5);
		const broker = brokerFor([a5]);
		const res = await broker.handle({ authToken: 'garbage', body: { hook_event_name: 'UserPromptSubmit' } });
		expect(res.status).toBe(401);
		expect(a5.begin).not.toHaveBeenCalled();
	});
});
