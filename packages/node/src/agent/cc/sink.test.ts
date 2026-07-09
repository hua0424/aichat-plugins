import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CcBroker } from './broker.js';
import { InMemoryBindTokenStore } from '../bind-token-store.js';
import { CcSessionRegistry, buildCcBridgeSink, type CcEventPush } from './sink.js';
import type { AgentEvent } from '../events.js';

// REQ-011 S3 (§5): the CC channel-push subsystem is DEAD (S2 removed the runtime wiring; the dead
// endpoint/MCP files were deleted in aichatoverview#164). Guard: no live `channelPush` reference in the
// runtime message/registry path, so an accidental re-wire is caught.
describe('REQ-011 S3 — channel dead-path stays unwired (no live channelPush)', () => {
	const runtimeFiles = [
		'../../handler/message.ts',
		'./sink.ts',
		'./headless-driver.ts',
		'../../commands/start.ts',
	];
	for (const rel of runtimeFiles) {
		it(`${rel} has no live channelPush reference`, () => {
			const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8');
			expect(src).not.toContain('channelPush');
		});
	}
});

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
	// #120: the sink no longer has a `thinking` method — thinking is teed from the driver's stdout, not
	// bridged from a hook. Only `tool` (PostToolUse) pushes an event; `flush` (Stop) is a no-op.
	it('tool → {tool} event; flush → no push', () => {
		const reg = new CcSessionRegistry();
		const got: AgentEvent[] = [];
		reg.register(9, (e) => got.push(e));
		const sink = buildCcBridgeSink(reg);

		sink.tool(9, 5, 'Bash');
		sink.flush(9, 5);

		expect(got).toEqual([{ type: 'tool', name: 'Bash', phase: 'end' }]);
	});

	it('a hook for a room with no active session is dropped safely', () => {
		const reg = new CcSessionRegistry();
		const sink = buildCcBridgeSink(reg);
		expect(() => sink.tool(999, 5, 'Bash')).not.toThrow();
		expect(() => sink.flush(999, 5)).not.toThrow();
	});
});

/** Drive a hook end-to-end through the real broker (resolve = opaque bind-token store, sink = the bridge). */
describe('CcBroker → buildCcBridgeSink end-to-end routing (REQ-011 S2)', () => {
	function harness() {
		const reg = new CcSessionRegistry();
		// REQ-029 (#29): roomId keys are opaque strings (the broker resolves them from the bind token).
		const got = new Map<string, AgentEvent[]>();
		const register = (roomId: string): CcEventPush => {
			const arr: AgentEvent[] = [];
			got.set(roomId, arr);
			const push: CcEventPush = (ev) => arr.push(ev);
			reg.register(roomId, push);
			return push;
		};
		// BL-014 (#141): the broker resolves the OPAQUE minted token via the store, exactly like start.ts.
		const bindTokens = new InMemoryBindTokenStore();
		const token = bindTokens.mint('5', '42'); // the (uid,room) these tests drive
		const broker = new CcBroker({ resolve: (t) => bindTokens.resolve(t), sink: buildCcBridgeSink(reg) });
		return { reg, got, register, broker, token };
	}

	it('#120: PostToolUse → {tool} on the binding-owner room only; MessageDisplay routes nothing', async () => {
		const h = harness();
		h.register('42'); // active session for room 42 (uid 5)

		// #120: MessageDisplay is no longer bridged (thinking is teed from stdout) — it pushes nothing.
		await h.broker.handle({ authToken: h.token, body: { hook_event_name: 'MessageDisplay', content: 'streaming' } });
		await h.broker.handle({ authToken: h.token, body: { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { cmd: 'ls' } } });

		expect(h.got.get('42')).toEqual([{ type: 'tool', name: 'Bash', phase: 'end' }]);
	});

	it('SessionStart / UserPromptSubmit lifecycle → nothing pushed (handler does THINKING_START)', async () => {
		const h = harness();
		h.register('42');
		await h.broker.handle({ authToken: h.token, body: { hook_event_name: 'SessionStart' } });
		await h.broker.handle({ authToken: h.token, body: { hook_event_name: 'UserPromptSubmit' } });
		expect(h.got.get('42')).toEqual([]);
	});

	it('Stop → 200 ok, nothing pushed, no throw (done comes from stdout EOF, not the hook)', async () => {
		const h = harness();
		h.register('42');
		const res = await h.broker.handle({ authToken: h.token, body: { hook_event_name: 'Stop', last_assistant_message: 'x' } });
		expect(res.status).toBe(200);
		expect(h.got.get('42')).toEqual([]);
	});

	it('late/racing hook with NO active session for the room → 200 ok, safe no-op drop (no throw)', async () => {
		const h = harness(); // no register() → no active session
		const res = await h.broker.handle({ authToken: h.token, body: { hook_event_name: 'PostToolUse', tool_name: 'Bash' } });
		expect(res.status).toBe(200);
		expect(h.got.get('42')).toBeUndefined();
	});

	it('unparseable binding → 401, nothing routed', async () => {
		const h = harness();
		const spy = vi.fn();
		h.reg.register(9, spy);
		const res = await h.broker.handle({ authToken: 'garbage', body: { hook_event_name: 'PostToolUse', tool_name: 'Bash' } });
		expect(res.status).toBe(401);
		expect(spy).not.toHaveBeenCalled();
	});
});
