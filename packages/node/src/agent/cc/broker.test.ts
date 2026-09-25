import { describe, it, expect, vi } from 'vitest';
import { CcBroker, ccBrokerPort, type CcHookSink } from './broker.js';

const BIND = 'bind-tok-abc';
const BINDING = { aiclawUid: '999', roomId: '7' };
const RUN = 'actual-run';
function harness() {
	const sink: CcHookSink = { tool: vi.fn(), flush: vi.fn() };
	const resolve = vi.fn((token: string) => token === BIND ? BINDING : undefined);
	const broker = new CcBroker({ resolve, sink });
	const hook = (event: string, options: { authToken?: string; remoteAddress?: string; runId?: string; body?: object } = {}) =>
		broker.handle({ body: { hook_event_name: event, ...options.body }, authToken: options.authToken ?? BIND, runId: options.runId ?? RUN, remoteAddress: options.remoteAddress });
	return { broker, hook, sink, resolve };
}

describe('CcBroker.handle — binding and run', () => {
	it('rejects non-loopback, missing/unknown binding, malformed hook or missing run without emitting', async () => {
		const h = harness();
		expect((await h.hook('PostToolUse', { remoteAddress: '10.0.0.5' })).status).toBe(403);
		expect(h.resolve).not.toHaveBeenCalled();
		expect((await h.broker.handle({ body: { hook_event_name: 'PostToolUse' } })).status).toBe(401);
		expect((await h.hook('PostToolUse', { authToken: 'unknown' })).status).toBe(401);
		expect((await h.broker.handle({ body: {}, authToken: BIND, runId: RUN })).status).toBe(400);
		expect((await h.broker.handle({ body: { hook_event_name: 'PostToolUse' }, authToken: BIND })).status).toBe(400);
		expect((await h.broker.handle({ body: { hook_event_name: 'Stop' }, authToken: BIND, runId: 'x'.repeat(129) })).status).toBe(400);
		expect(h.sink.tool).not.toHaveBeenCalled();
		expect(h.sink.flush).not.toHaveBeenCalled();
	});

	it('forwards the trusted identity + room and explicit run for tools and Stop only', async () => {
		const h = harness();
		expect((await h.hook('PostToolUse', { remoteAddress: '127.0.0.1', body: { tool_name: 'Bash' } })).status).toBe(200);
		expect(h.sink.tool).toHaveBeenCalledWith('7', '999', RUN, 'Bash');
		await h.hook('PostToolUse');
		expect(h.sink.tool).toHaveBeenCalledWith('7', '999', RUN, 'tool');
		expect((await h.hook('Stop')).status).toBe(200);
		expect(h.sink.flush).toHaveBeenCalledWith('7', '999', RUN);
		for (const name of ['UserPromptSubmit', 'SessionStart', 'MessageDisplay', 'Unknown']) {
			expect((await h.hook(name)).status).toBe(200);
		}
		expect(h.sink.tool).toHaveBeenCalledTimes(2);
		expect(h.sink.flush).toHaveBeenCalledTimes(1);
	});
});

describe('CcBroker.listen / close — real TCP loopback', () => {
	it('round-trips the Authorization and X-Aichat-Run headers; missing run cannot emit', async () => {
		const h = harness();
		await h.broker.listen(0, '127.0.0.1');
		try {
			const url = `http://127.0.0.1:${h.broker.address()!.port}/hook`;
			const body = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash' });
			const headers = { Authorization: `Bearer ${BIND}`, 'Content-Type': 'application/json' };
			expect((await fetch(url, { method: 'POST', headers, body })).status).toBe(400);
			expect(h.sink.tool).not.toHaveBeenCalled();
			expect((await fetch(url, { method: 'POST', headers: { ...headers, 'X-Aichat-Run': RUN }, body })).status).toBe(200);
			expect(h.sink.tool).toHaveBeenCalledWith('7', '999', RUN, 'Bash');
		} finally {
			await h.broker.close();
		}
	});
});

describe('ccBrokerPort', () => {
	it('uses 9100 by default and honors a valid override', () => {
		const prev = process.env.AICHAT_CC_BROKER_PORT;
		try {
			delete process.env.AICHAT_CC_BROKER_PORT;
			expect(ccBrokerPort()).toBe(9100);
			process.env.AICHAT_CC_BROKER_PORT = '9200';
			expect(ccBrokerPort()).toBe(9200);
		} finally {
			if (prev !== undefined) process.env.AICHAT_CC_BROKER_PORT = prev;
			else delete process.env.AICHAT_CC_BROKER_PORT;
		}
	});
});
