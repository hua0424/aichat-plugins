import { describe, it, expect, vi } from 'vitest';
import { CcBroker, ccBrokerPort, type CcHookSink } from './broker.js';

/**
 * A spy sink recording (roomId, aiclawUid[, name]) per call. (#120) The sink no longer has a `thinking`
 * method — thinking is teed from the driver's stdout, not sourced from a hook. The broker's live sink
 * calls are `tool` (PostToolUse) and `flush` (Stop).
 */
function fakeSink() {
	const tools: Array<{ roomId: number; aiclawUid: number; toolName: string }> = [];
	const flushes: Array<{ roomId: number; aiclawUid: number }> = [];
	const sink: CcHookSink = {
		tool: vi.fn((roomId, aiclawUid, toolName) => tools.push({ roomId, aiclawUid, toolName })),
		flush: vi.fn((roomId, aiclawUid) => flushes.push({ roomId, aiclawUid })),
	};
	return { sink, tools, flushes };
}

/** A resolve() that maps one known token → a fixed binding; everything else undefined. */
function fakeResolver(token: string, binding: { aiclawUid: number; roomId: number }) {
	return vi.fn((t: string) => (t === token ? binding : undefined));
}

const BIND = 'bind-tok-abc';
const BINDING = { aiclawUid: 999, roomId: 7 };

describe('CcBroker.handle — guards', () => {
	it('rejects a non-loopback remoteAddress with 403 and never resolves/emits', async () => {
		const { sink } = fakeSink();
		const resolve = fakeResolver(BIND, BINDING);
		const broker = new CcBroker({ resolve, sink });

		const out = await broker.handle({
			body: { hook_event_name: 'UserPromptSubmit', prompt_text: 'hi' },
			remoteAddress: '10.0.0.5',
			authToken: BIND,
		});

		expect(out.status).toBe(403);
		expect(resolve).not.toHaveBeenCalled();
		expect(sink.tool).not.toHaveBeenCalled();
	});

	it('allows a loopback remoteAddress (127.0.0.1)', async () => {
		const { sink } = fakeSink();
		const broker = new CcBroker({ resolve: fakeResolver(BIND, BINDING), sink });

		const out = await broker.handle({
			body: { hook_event_name: 'PostToolUse', tool_name: 'Bash' },
			remoteAddress: '127.0.0.1',
			authToken: BIND,
		});

		expect(out.status).toBe(200);
		expect(sink.tool).toHaveBeenCalledWith(7, 999, 'Bash');
	});

	it('allows an undefined remoteAddress', async () => {
		const { sink } = fakeSink();
		const broker = new CcBroker({ resolve: fakeResolver(BIND, BINDING), sink });

		const out = await broker.handle({ body: { hook_event_name: 'Stop' }, authToken: BIND });

		expect(out.status).toBe(200);
		expect(sink.flush).toHaveBeenCalledWith(7, 999);
	});
});

describe('CcBroker.handle — binding resolution', () => {
	it('parses the Bearer token and passes it to resolve()', async () => {
		const { sink } = fakeSink();
		const resolve = fakeResolver(BIND, BINDING);
		const broker = new CcBroker({ resolve, sink });

		await broker.handle({ body: { hook_event_name: 'Stop' }, authToken: BIND });

		expect(resolve).toHaveBeenCalledWith(BIND);
	});

	it('unknown token (resolve→undefined) → 401/404 and sink NOT called', async () => {
		const { sink } = fakeSink();
		const resolve = fakeResolver(BIND, BINDING);
		const broker = new CcBroker({ resolve, sink });

		const out = await broker.handle({ body: { hook_event_name: 'PostToolUse', tool_name: 'Bash' }, authToken: 'wrong' });

		expect([401, 404]).toContain(out.status);
		expect(sink.tool).not.toHaveBeenCalled();
		expect(sink.flush).not.toHaveBeenCalled();
	});

	it('missing token → 401/404 and sink NOT called', async () => {
		const { sink } = fakeSink();
		const broker = new CcBroker({ resolve: fakeResolver(BIND, BINDING), sink });

		const out = await broker.handle({ body: { hook_event_name: 'PostToolUse', tool_name: 'Bash' } });

		expect([401, 404]).toContain(out.status);
		expect(sink.tool).not.toHaveBeenCalled();
	});
});

describe('CcBroker.handle — hook event → sink mapping', () => {
	it('UserPromptSubmit → lifecycle ignored (no sink call), 200 ok', async () => {
		const { sink } = fakeSink();
		const broker = new CcBroker({ resolve: fakeResolver(BIND, BINDING), sink });

		const out = await broker.handle({ body: { hook_event_name: 'UserPromptSubmit', prompt_text: 'go' }, authToken: BIND });

		expect(out.status).toBe(200);
		expect(out.json).toEqual({ ok: true });
		expect(sink.tool).not.toHaveBeenCalled();
		expect(sink.flush).not.toHaveBeenCalled();
	});

	it('SessionStart → lifecycle ignored (no sink call)', async () => {
		const { sink } = fakeSink();
		const broker = new CcBroker({ resolve: fakeResolver(BIND, BINDING), sink });

		await broker.handle({ body: { hook_event_name: 'SessionStart', source: 'startup' }, authToken: BIND });

		expect(sink.tool).not.toHaveBeenCalled();
		expect(sink.flush).not.toHaveBeenCalled();
	});

	it('PostToolUse → sink.tool(roomId, aiclawUid, tool_name)', async () => {
		const { sink, tools } = fakeSink();
		const broker = new CcBroker({ resolve: fakeResolver(BIND, BINDING), sink });

		await broker.handle({
			body: {
				hook_event_name: 'PostToolUse',
				tool_name: 'Bash',
				tool_input: { command: 'ls -la' },
				tool_response: { stdout: 'a\nb' },
			},
			authToken: BIND,
		});

		expect(sink.tool).toHaveBeenCalledTimes(1);
		expect(tools[0]).toEqual({ roomId: 7, aiclawUid: 999, toolName: 'Bash' });
	});

	it('PostToolUse with no tool_name → falls back to "tool"', async () => {
		const { sink, tools } = fakeSink();
		const broker = new CcBroker({ resolve: fakeResolver(BIND, BINDING), sink });

		await broker.handle({ body: { hook_event_name: 'PostToolUse' }, authToken: BIND });

		expect(tools[0].toolName).toBe('tool');
	});

	it('#120: MessageDisplay is now a no-op (routed nowhere) — 200 ok, no sink call', async () => {
		const { sink } = fakeSink();
		const broker = new CcBroker({ resolve: fakeResolver(BIND, BINDING), sink });

		// #120: thinking is teed from the driver's stdout, not from a MessageDisplay hook. The event has no
		// case → it hits the default branch (accepted, routed nowhere). The `content` field is ignored.
		const out = await broker.handle({ body: { hook_event_name: 'MessageDisplay', content: 'streaming text' }, authToken: BIND });

		expect(out.status).toBe(200);
		expect(sink.tool).not.toHaveBeenCalled();
		expect(sink.flush).not.toHaveBeenCalled();
	});

	it('Stop → sink.flush(roomId, aiclawUid) (does NOT close the session)', async () => {
		const { sink } = fakeSink();
		const broker = new CcBroker({ resolve: fakeResolver(BIND, BINDING), sink });

		await broker.handle({
			body: { hook_event_name: 'Stop', last_assistant_message: 'done thinking' },
			authToken: BIND,
		});

		expect(sink.flush).toHaveBeenCalledWith(7, 999);
	});

	it('an unknown hook_event_name → 200 ok but no sink call', async () => {
		const { sink } = fakeSink();
		const broker = new CcBroker({ resolve: fakeResolver(BIND, BINDING), sink });

		const out = await broker.handle({ body: { hook_event_name: 'WeirdEvent' }, authToken: BIND });

		expect(out.status).toBe(200);
		expect(sink.tool).not.toHaveBeenCalled();
		expect(sink.flush).not.toHaveBeenCalled();
	});

	it('a malformed body (no hook_event_name) → 400, no sink call, but only after resolve', async () => {
		const { sink } = fakeSink();
		const broker = new CcBroker({ resolve: fakeResolver(BIND, BINDING), sink });

		const out = await broker.handle({ body: { not_a_hook: true }, authToken: BIND });

		expect(out.status).toBe(400);
		expect(sink.tool).not.toHaveBeenCalled();
	});
});

describe('CcBroker.listen / close — real TCP loopback', () => {
	it('parses Authorization: Bearer header and round-trips a hook POST', async () => {
		const { sink } = fakeSink();
		const broker = new CcBroker({ resolve: fakeResolver(BIND, BINDING), sink });
		// ephemeral port for the test (0); the production default is fixed (9100).
		await broker.listen(0, '127.0.0.1');
		try {
			const addr = broker.address();
			expect(addr).not.toBeNull();
			const res = await fetch(`http://127.0.0.1:${addr!.port}/`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${BIND}` },
				body: JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: 'x' }),
			});
			expect(res.status).toBe(200);
			await res.json();
			expect(sink.flush).toHaveBeenCalledWith(7, 999);
		} finally {
			await broker.close();
		}
	});

	it('a POST with no Authorization header → 401/404', async () => {
		const { sink } = fakeSink();
		const broker = new CcBroker({ resolve: fakeResolver(BIND, BINDING), sink });
		await broker.listen(0, '127.0.0.1');
		try {
			const addr = broker.address();
			const res = await fetch(`http://127.0.0.1:${addr!.port}/`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ hook_event_name: 'Stop' }),
			});
			expect([401, 404]).toContain(res.status);
			expect(sink.flush).not.toHaveBeenCalled();
		} finally {
			await broker.close();
		}
	});
});

describe('ccBrokerPort', () => {
	it('defaults to 9100 when AICHAT_CC_BROKER_PORT is unset', () => {
		const prev = process.env.AICHAT_CC_BROKER_PORT;
		delete process.env.AICHAT_CC_BROKER_PORT;
		try {
			expect(ccBrokerPort()).toBe(9100);
		} finally {
			if (prev !== undefined) process.env.AICHAT_CC_BROKER_PORT = prev;
		}
	});

	it('honors AICHAT_CC_BROKER_PORT override', () => {
		const prev = process.env.AICHAT_CC_BROKER_PORT;
		process.env.AICHAT_CC_BROKER_PORT = '9200';
		try {
			expect(ccBrokerPort()).toBe(9200);
		} finally {
			if (prev !== undefined) process.env.AICHAT_CC_BROKER_PORT = prev;
			else delete process.env.AICHAT_CC_BROKER_PORT;
		}
	});
});
