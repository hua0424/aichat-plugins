import { describe, it, expect, vi } from 'vitest';
import WebSocket from 'ws';
import { CcChannelEndpoint, ccChannelPort, isLoopback } from './channel-endpoint.js';

const BIND = 'aiclaw-999-room-7';
const BINDING = { aiclawUid: 999, roomId: 7 };

/** A resolve() that maps one known token → a fixed binding; everything else undefined. */
function fakeResolver(token: string, binding: { aiclawUid: number; roomId: number }) {
	return vi.fn((t: string) => (t === token ? binding : undefined));
}

/** Open a ws client to the endpoint's ephemeral port and resolve once it's open. */
async function connect(endpoint: CcChannelEndpoint): Promise<WebSocket> {
	const port = endpoint.address()!.port;
	const ws = new WebSocket(`ws://127.0.0.1:${port}`);
	await new Promise<void>((resolve, reject) => {
		ws.once('open', () => resolve());
		ws.once('error', reject);
	});
	return ws;
}

/** Wait for the next text frame on a ws client (parsed). */
function nextFrame(ws: WebSocket): Promise<Record<string, unknown>> {
	return new Promise((resolve) => ws.once('message', (raw: Buffer) => resolve(JSON.parse(raw.toString('utf-8')))));
}

/** Spin until cond() or timeout (the server registers a subscriber a tick after the client sends). */
async function waitFor(cond: () => boolean, timeoutMs = 500): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
		await new Promise((r) => setTimeout(r, 5));
	}
}

describe('CcChannelEndpoint.subscribe / push — real loopback', () => {
	it('a valid binding subscribes under its room; push reaches the socket', async () => {
		const endpoint = new CcChannelEndpoint({ resolve: fakeResolver(BIND, BINDING) });
		await endpoint.listen(0, '127.0.0.1');
		try {
			const ws = await connect(endpoint);
			const got = nextFrame(ws);
			ws.send(JSON.stringify({ type: 'subscribe', bindToken: BIND }));
			// give the server a tick to register before pushing
			await waitFor(() => true, 20);
			await new Promise((r) => setTimeout(r, 20));
			endpoint.push(7, 'hello cc');
			expect(await got).toEqual({ type: 'message', content: 'hello cc' });
			ws.close();
		} finally {
			await endpoint.close();
		}
	});

	it('an unknown binding → socket receives {type:error} and is closed (not registered)', async () => {
		const endpoint = new CcChannelEndpoint({ resolve: fakeResolver(BIND, BINDING) });
		await endpoint.listen(0, '127.0.0.1');
		try {
			const ws = await connect(endpoint);
			const got = nextFrame(ws);
			const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
			ws.send(JSON.stringify({ type: 'subscribe', bindToken: 'wrong' }));
			expect(await got).toEqual({ type: 'error', error: 'unknown binding' });
			await closed; // the server closed it → never registered
			// a push for that room reaches no one (no throw)
			expect(() => endpoint.push(7, 'x')).not.toThrow();
		} finally {
			await endpoint.close();
		}
	});

	it('push only reaches sockets subscribed for THAT room', async () => {
		const resolve = vi.fn((t: string) =>
			t === 'aiclaw-999-room-7' ? { aiclawUid: 999, roomId: 7 } : t === 'aiclaw-999-room-8' ? { aiclawUid: 999, roomId: 8 } : undefined,
		);
		const endpoint = new CcChannelEndpoint({ resolve });
		await endpoint.listen(0, '127.0.0.1');
		try {
			const wsA = await connect(endpoint);
			const wsB = await connect(endpoint);
			wsA.send(JSON.stringify({ type: 'subscribe', bindToken: 'aiclaw-999-room-7' }));
			wsB.send(JSON.stringify({ type: 'subscribe', bindToken: 'aiclaw-999-room-8' }));
			await new Promise((r) => setTimeout(r, 30)); // let both register

			const gotA = nextFrame(wsA);
			let bGotSomething = false;
			wsB.once('message', () => {
				bGotSomething = true;
			});
			endpoint.push(7, 'for room 7');
			expect(await gotA).toEqual({ type: 'message', content: 'for room 7' });
			await new Promise((r) => setTimeout(r, 30));
			expect(bGotSomething).toBe(false); // room-8 socket never received room-7's push
			wsA.close();
			wsB.close();
		} finally {
			await endpoint.close();
		}
	});

	it('push to a room with no subscriber is a safe no-op', async () => {
		const endpoint = new CcChannelEndpoint({ resolve: fakeResolver(BIND, BINDING) });
		await endpoint.listen(0, '127.0.0.1');
		try {
			expect(() => endpoint.push(7, 'nobody home')).not.toThrow();
		} finally {
			await endpoint.close();
		}
	});

	it('includes meta only when provided', async () => {
		const endpoint = new CcChannelEndpoint({ resolve: fakeResolver(BIND, BINDING) });
		await endpoint.listen(0, '127.0.0.1');
		try {
			const ws = await connect(endpoint);
			ws.send(JSON.stringify({ type: 'subscribe', bindToken: BIND }));
			await new Promise((r) => setTimeout(r, 30));
			const got = nextFrame(ws);
			endpoint.push(7, 'with meta', { fromUid: 555 });
			expect(await got).toEqual({ type: 'message', content: 'with meta', meta: { fromUid: 555 } });
			ws.close();
		} finally {
			await endpoint.close();
		}
	});

	it('socket close de-registers it (a later push for its room reaches no one)', async () => {
		const endpoint = new CcChannelEndpoint({ resolve: fakeResolver(BIND, BINDING) });
		await endpoint.listen(0, '127.0.0.1');
		try {
			const ws = await connect(endpoint);
			ws.send(JSON.stringify({ type: 'subscribe', bindToken: BIND }));
			await new Promise((r) => setTimeout(r, 30));
			// @ts-expect-error white-box: the room set exists while subscribed
			expect(endpoint.rooms.get(7)?.size).toBe(1);
			ws.close();
			// @ts-expect-error white-box: after close the set is cleaned up
			await waitFor(() => endpoint.rooms.get(7) === undefined);
			expect(() => endpoint.push(7, 'after close')).not.toThrow();
		} finally {
			await endpoint.close();
		}
	});
});

describe('isLoopback (the connection guard predicate)', () => {
	it('treats undefined / 127.0.0.1 / ::1 / ::ffff:127.0.0.1 as loopback', () => {
		expect(isLoopback(undefined)).toBe(true);
		expect(isLoopback('127.0.0.1')).toBe(true);
		expect(isLoopback('::1')).toBe(true);
		expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
	});

	it('rejects a real remote address', () => {
		expect(isLoopback('10.0.0.5')).toBe(false);
		expect(isLoopback('192.168.8.83')).toBe(false);
	});
});

describe('ccChannelPort', () => {
	it('defaults to 9101 when AICHAT_CC_CHANNEL_PORT is unset', () => {
		const prev = process.env.AICHAT_CC_CHANNEL_PORT;
		delete process.env.AICHAT_CC_CHANNEL_PORT;
		try {
			expect(ccChannelPort()).toBe(9101);
		} finally {
			if (prev !== undefined) process.env.AICHAT_CC_CHANNEL_PORT = prev;
		}
	});

	it('honors AICHAT_CC_CHANNEL_PORT override', () => {
		const prev = process.env.AICHAT_CC_CHANNEL_PORT;
		process.env.AICHAT_CC_CHANNEL_PORT = '9202';
		try {
			expect(ccChannelPort()).toBe(9202);
		} finally {
			if (prev !== undefined) process.env.AICHAT_CC_CHANNEL_PORT = prev;
			else delete process.env.AICHAT_CC_CHANNEL_PORT;
		}
	});
});
