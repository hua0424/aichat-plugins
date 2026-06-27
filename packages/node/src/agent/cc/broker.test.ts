import { describe, it, expect, vi } from 'vitest';
import { CcBroker, ccBrokerPort, type ExternalThinkingSink } from './broker.js';

/** A spy sink recording (roomId, aiclawUid[, text]) per call. */
function fakeSink() {
	const begins: Array<{ roomId: number; aiclawUid: number }> = [];
	const deltas: Array<{ roomId: number; aiclawUid: number; text: string }> = [];
	const ends: Array<{ roomId: number; aiclawUid: number }> = [];
	const sink: ExternalThinkingSink = {
		begin: vi.fn((roomId, aiclawUid) => begins.push({ roomId, aiclawUid })),
		delta: vi.fn((roomId, aiclawUid, text) => deltas.push({ roomId, aiclawUid, text })),
		end: vi.fn((roomId, aiclawUid) => ends.push({ roomId, aiclawUid })),
	};
	return { sink, begins, deltas, ends };
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
		expect(sink.begin).not.toHaveBeenCalled();
	});

	it('allows a loopback remoteAddress (127.0.0.1)', async () => {
		const { sink } = fakeSink();
		const broker = new CcBroker({ resolve: fakeResolver(BIND, BINDING), sink });

		const out = await broker.handle({
			body: { hook_event_name: 'UserPromptSubmit' },
			remoteAddress: '127.0.0.1',
			authToken: BIND,
		});

		expect(out.status).toBe(200);
		expect(sink.begin).toHaveBeenCalledWith(7, 999);
	});

	it('allows an undefined remoteAddress', async () => {
		const { sink } = fakeSink();
		const broker = new CcBroker({ resolve: fakeResolver(BIND, BINDING), sink });

		const out = await broker.handle({ body: { hook_event_name: 'SessionStart' }, authToken: BIND });

		expect(out.status).toBe(200);
		expect(sink.begin).toHaveBeenCalledWith(7, 999);
	});
});

describe('CcBroker.handle — binding resolution', () => {
	it('parses the Bearer token and passes it to resolve()', async () => {
		const { sink } = fakeSink();
		const resolve = fakeResolver(BIND, BINDING);
		const broker = new CcBroker({ resolve, sink });

		await broker.handle({ body: { hook_event_name: 'SessionStart' }, authToken: BIND });

		expect(resolve).toHaveBeenCalledWith(BIND);
	});

	it('unknown token (resolve→undefined) → 401/404 and sink NOT called', async () => {
		const { sink } = fakeSink();
		const resolve = fakeResolver(BIND, BINDING);
		const broker = new CcBroker({ resolve, sink });

		const out = await broker.handle({ body: { hook_event_name: 'UserPromptSubmit' }, authToken: 'wrong' });

		expect([401, 404]).toContain(out.status);
		expect(sink.begin).not.toHaveBeenCalled();
		expect(sink.delta).not.toHaveBeenCalled();
		expect(sink.end).not.toHaveBeenCalled();
	});

	it('missing token → 401/404 and sink NOT called', async () => {
		const { sink } = fakeSink();
		const broker = new CcBroker({ resolve: fakeResolver(BIND, BINDING), sink });

		const out = await broker.handle({ body: { hook_event_name: 'UserPromptSubmit' } });

		expect([401, 404]).toContain(out.status);
		expect(sink.begin).not.toHaveBeenCalled();
	});
});

describe('CcBroker.handle — hook event → sink mapping', () => {
	it('UserPromptSubmit → sink.begin(roomId, aiclawUid)', async () => {
		const { sink } = fakeSink();
		const broker = new CcBroker({ resolve: fakeResolver(BIND, BINDING), sink });

		const out = await broker.handle({ body: { hook_event_name: 'UserPromptSubmit', prompt_text: 'go' }, authToken: BIND });

		expect(out.status).toBe(200);
		expect(out.json).toEqual({ ok: true });
		expect(sink.begin).toHaveBeenCalledWith(7, 999);
	});

	it('SessionStart → sink.begin(roomId, aiclawUid)', async () => {
		const { sink } = fakeSink();
		const broker = new CcBroker({ resolve: fakeResolver(BIND, BINDING), sink });

		await broker.handle({ body: { hook_event_name: 'SessionStart', source: 'startup' }, authToken: BIND });

		expect(sink.begin).toHaveBeenCalledWith(7, 999);
	});

	it('PostToolUse → sink.delta with "[工具] " + tool_name + truncated tool_input JSON', async () => {
		const { sink, deltas } = fakeSink();
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

		expect(sink.delta).toHaveBeenCalledTimes(1);
		expect(deltas[0].roomId).toBe(7);
		expect(deltas[0].aiclawUid).toBe(999);
		expect(deltas[0].text).toContain('[工具] Bash');
		expect(deltas[0].text).toContain('ls -la');
	});

	it('PostToolUse → tool_input JSON is sliced to 200 chars', async () => {
		const { sink, deltas } = fakeSink();
		const broker = new CcBroker({ resolve: fakeResolver(BIND, BINDING), sink });

		const longCmd = 'x'.repeat(500);
		await broker.handle({
			body: { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: longCmd } },
			authToken: BIND,
		});

		const text = deltas[0].text;
		// "[工具] Bash " prefix + at most 200 chars of JSON
		const jsonPart = text.slice('[工具] Bash '.length);
		expect(jsonPart.length).toBeLessThanOrEqual(200);
	});

	it('MessageDisplay → sink.delta(content)', async () => {
		const { sink, deltas } = fakeSink();
		const broker = new CcBroker({ resolve: fakeResolver(BIND, BINDING), sink });

		await broker.handle({ body: { hook_event_name: 'MessageDisplay', content: 'streaming text' }, authToken: BIND });

		expect(sink.delta).toHaveBeenCalledTimes(1);
		expect(deltas[0].text).toBe('streaming text');
	});

	it('Stop → sink.end(roomId, aiclawUid)', async () => {
		const { sink } = fakeSink();
		const broker = new CcBroker({ resolve: fakeResolver(BIND, BINDING), sink });

		await broker.handle({
			body: { hook_event_name: 'Stop', last_assistant_message: 'done thinking' },
			authToken: BIND,
		});

		expect(sink.end).toHaveBeenCalledWith(7, 999);
	});

	it('an unknown hook_event_name → 200 ok but no sink call', async () => {
		const { sink } = fakeSink();
		const broker = new CcBroker({ resolve: fakeResolver(BIND, BINDING), sink });

		const out = await broker.handle({ body: { hook_event_name: 'WeirdEvent' }, authToken: BIND });

		expect(out.status).toBe(200);
		expect(sink.begin).not.toHaveBeenCalled();
		expect(sink.delta).not.toHaveBeenCalled();
		expect(sink.end).not.toHaveBeenCalled();
	});

	it('a malformed body (no hook_event_name) → 400, no sink call, but only after resolve', async () => {
		const { sink } = fakeSink();
		const broker = new CcBroker({ resolve: fakeResolver(BIND, BINDING), sink });

		const out = await broker.handle({ body: { not_a_hook: true }, authToken: BIND });

		expect(out.status).toBe(400);
		expect(sink.begin).not.toHaveBeenCalled();
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
			expect(sink.end).toHaveBeenCalledWith(7, 999);
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
			expect(sink.end).not.toHaveBeenCalled();
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
