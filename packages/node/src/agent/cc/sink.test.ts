import { describe, it, expect, vi } from 'vitest';
import { CcBroker } from './broker.js';
import { parseCcBinding } from './cc-driver.js';
import { CcSessionRegistry, buildCcBridgeSink, type CcEventPush } from './sink.js';
import type { AgentEvent } from '../events.js';

describe('CcSessionRegistry', () => {
	it('register + push routes to the room push; deregister makes it a no-op', () => {
		const reg = new CcSessionRegistry();
		const got: AgentEvent[] = [];
		reg.register(9, (ev) => got.push(ev));
		reg.push(9, { type: 'thinking', text: 'x' });
		expect(got).toEqual([{ type: 'thinking', text: 'x' }]);

		reg.deregister(9);
		reg.push(9, { type: 'thinking', text: 'after' });
		expect(got).toEqual([{ type: 'thinking', text: 'x' }]); // unchanged
	});

	it('push to a room with no registered session is a safe no-op (no throw)', () => {
		const reg = new CcSessionRegistry();
		expect(() => reg.push(123, { type: 'thinking', text: 'orphan' })).not.toThrow();
	});

	it('isolates rooms: a push for room A never reaches room B', () => {
		const reg = new CcSessionRegistry();
		const a: AgentEvent[] = [];
		const b: AgentEvent[] = [];
		reg.register(1, (e) => a.push(e));
		reg.register(2, (e) => b.push(e));
		reg.push(1, { type: 'thinking', text: 'to-a' });
		expect(a).toHaveLength(1);
		expect(b).toHaveLength(0);
	});
});

describe('buildCcBridgeSink', () => {
	it('tool → {tool} event; thinking → {thinking} event; flush → no push', () => {
		const reg = new CcSessionRegistry();
		const got: AgentEvent[] = [];
		reg.register(9, (e) => got.push(e));
		const sink = buildCcBridgeSink(reg);

		sink.thinking(9, 5, 'reasoning...');
		sink.tool(9, 5, 'Bash');
		sink.flush(9, 5);

		expect(got).toEqual([
			{ type: 'thinking', text: 'reasoning...' },
			{ type: 'tool', name: 'Bash', phase: 'end' },
		]);
	});

	it('a hook for a room with no active session is dropped safely', () => {
		const reg = new CcSessionRegistry();
		const sink = buildCcBridgeSink(reg);
		expect(() => sink.thinking(999, 5, 'no session')).not.toThrow();
		expect(() => sink.tool(999, 5, 'Bash')).not.toThrow();
		expect(() => sink.flush(999, 5)).not.toThrow();
	});
});

/** Drive a hook end-to-end through the real broker (resolve = parseCcBinding, sink = the bridge). */
describe('CcBroker → buildCcBridgeSink end-to-end routing (REQ-011 S2)', () => {
	function harness() {
		const reg = new CcSessionRegistry();
		const got = new Map<number, AgentEvent[]>();
		const register = (roomId: number): CcEventPush => {
			const arr: AgentEvent[] = [];
			got.set(roomId, arr);
			const push: CcEventPush = (ev) => arr.push(ev);
			reg.register(roomId, push);
			return push;
		};
		const broker = new CcBroker({ resolve: parseCcBinding, sink: buildCcBridgeSink(reg) });
		return { reg, got, register, broker };
	}

	it('MessageDisplay → {thinking}; PostToolUse → {tool}; on the binding-owner room only', async () => {
		const h = harness();
		h.register(42); // active session for room 42 (uid 5)

		await h.broker.handle({ authToken: 'aiclaw-5-room-42', body: { hook_event_name: 'MessageDisplay', content: 'streaming' } });
		await h.broker.handle({ authToken: 'aiclaw-5-room-42', body: { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { cmd: 'ls' } } });

		expect(h.got.get(42)).toEqual([
			{ type: 'thinking', text: 'streaming' },
			{ type: 'tool', name: 'Bash', phase: 'end' },
		]);
	});

	it('SessionStart / UserPromptSubmit lifecycle → nothing pushed (handler does THINKING_START)', async () => {
		const h = harness();
		h.register(42);
		await h.broker.handle({ authToken: 'aiclaw-5-room-42', body: { hook_event_name: 'SessionStart' } });
		await h.broker.handle({ authToken: 'aiclaw-5-room-42', body: { hook_event_name: 'UserPromptSubmit' } });
		expect(h.got.get(42)).toEqual([]);
	});

	it('Stop → 200 ok, nothing pushed, no throw (done comes from stdout EOF, not the hook)', async () => {
		const h = harness();
		h.register(42);
		const res = await h.broker.handle({ authToken: 'aiclaw-5-room-42', body: { hook_event_name: 'Stop', last_assistant_message: 'x' } });
		expect(res.status).toBe(200);
		expect(h.got.get(42)).toEqual([]);
	});

	it('late/racing hook with NO active session for the room → 200 ok, safe no-op drop (no throw)', async () => {
		const h = harness(); // no register() → no active session
		const res = await h.broker.handle({ authToken: 'aiclaw-5-room-42', body: { hook_event_name: 'MessageDisplay', content: 'orphan' } });
		expect(res.status).toBe(200);
		expect(h.got.get(42)).toBeUndefined();
	});

	it('unparseable binding → 401, nothing routed', async () => {
		const h = harness();
		const spy = vi.fn();
		h.reg.register(9, spy);
		const res = await h.broker.handle({ authToken: 'garbage', body: { hook_event_name: 'MessageDisplay', content: 'x' } });
		expect(res.status).toBe(401);
		expect(spy).not.toHaveBeenCalled();
	});
});
