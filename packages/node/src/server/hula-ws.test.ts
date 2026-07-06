import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * #152 ws liveness watchdog.
 *
 * Mock the `ws` module with a tiny controllable fake so tests can drive
 * readyState + emit 'open'/'pong'/'message'/'close' and assert
 * terminate/ping/close/send calls. A minimal hand-rolled emitter keeps the
 * mock self-contained (no cross-hoist import of node:events).
 */
const hoisted = vi.hoisted(() => {
	const instances: MockWebSocket[] = [];
	class MockWebSocket {
		static OPEN = 1;
		static CLOSED = 3;
		readyState = MockWebSocket.OPEN;
		private handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
		send = vi.fn();
		ping = vi.fn();
		terminate = vi.fn(() => {
			// real ws.terminate() destroys the socket and still fires 'close'
			this.readyState = MockWebSocket.CLOSED;
			this.emit('close', 1006, Buffer.from('terminated'));
		});
		close = vi.fn(() => {
			this.readyState = MockWebSocket.CLOSED;
			this.emit('close', 1000, Buffer.from('closed'));
		});
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		constructor(..._args: unknown[]) {
			instances.push(this);
		}
		on(event: string, cb: (...a: unknown[]) => void): this {
			(this.handlers[event] ||= []).push(cb);
			return this;
		}
		emit(event: string, ...args: unknown[]): void {
			for (const cb of this.handlers[event] ?? []) cb(...args);
		}
	}
	return { instances, MockWebSocket };
});

vi.mock('ws', () => ({ default: hoisted.MockWebSocket }));

import { HulaWSClient, type HulaWSClientOptions } from './hula-ws.js';

type MockWs = InstanceType<typeof hoisted.MockWebSocket>;

function makeClient(opts?: Partial<HulaWSClientOptions>) {
	const onMessage = vi.fn();
	const onDisconnected = vi.fn();
	const client = new HulaWSClient({
		url: 'ws://test',
		token: 'tok',
		clientId: 'mc',
		onMessage,
		onDisconnected,
		pingIntervalMs: 1000,
		deadAfterMs: 3000,
		...opts,
	});
	client.connect();
	const ws = hoisted.instances[hoisted.instances.length - 1] as MockWs;
	return { client, ws, onMessage, onDisconnected };
}

describe('HulaWSClient liveness watchdog (#152)', () => {
	beforeEach(() => {
		hoisted.instances.length = 0;
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('a) no false-kill: a pong each cycle refreshes liveness → terminate never called', () => {
		vi.useFakeTimers();
		const { ws } = makeClient();
		ws.emit('open');

		for (let i = 0; i < 10; i++) {
			// each pingIntervalMs the watchdog finds since < deadAfterMs → ws.ping()
			vi.advanceTimersByTime(1000);
			// server ponged → refresh lastAliveAt so the next cycle stays alive
			ws.emit('pong');
		}

		// 10s elapsed (>> deadAfterMs=3s) but liveness kept fresh → never killed
		expect(ws.terminate).not.toHaveBeenCalled();
		expect(ws.ping).toHaveBeenCalledTimes(10);
	});

	it('b) no false-kill: slow-but-alive inbound message refreshes liveness → terminate never called', () => {
		vi.useFakeTimers();
		const { ws, onMessage } = makeClient();
		ws.emit('open');

		for (let i = 0; i < 10; i++) {
			vi.advanceTimersByTime(1000);
			// any inbound frame proves liveness (not just pong)
			ws.emit('message', Buffer.from('{}'));
		}

		expect(ws.terminate).not.toHaveBeenCalled();
		expect(ws.ping).toHaveBeenCalledTimes(10);
		expect(onMessage).toHaveBeenCalledTimes(10);
	});

	it('c) half-open detected: no pong/message past deadAfterMs → terminate once + warn', () => {
		vi.useFakeTimers();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { ws } = makeClient();
		ws.emit('open');

		// ticks at 1000 (ping), 2000 (ping), 3000 (since=3000>=deadAfterMs → terminate)
		vi.advanceTimersByTime(3000);

		expect(ws.ping).toHaveBeenCalledTimes(2);
		expect(ws.terminate).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalled();
		const logged = warn.mock.calls.flat().join(' ');
		expect(logged).toContain('half-open');
	});

	it('d) terminate fires the existing close path (stopWatchdog + onDisconnected) then reconnects', () => {
		vi.useFakeTimers();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { ws, onDisconnected } = makeClient();
		ws.emit('open');

		vi.advanceTimersByTime(3000); // → terminate → mocked 'close'
		expect(ws.terminate).toHaveBeenCalledTimes(1);
		// the real close handler ran: onDisconnected fired
		expect(onDisconnected).toHaveBeenCalledTimes(1);

		// stopWatchdog cleared the interval on close → no further terminate churn;
		// scheduleReconnect (backoff 1000ms) then re-invokes connect() → a NEW ws instance.
		const before = hoisted.instances.length;
		vi.advanceTimersByTime(1000);
		expect(hoisted.instances.length).toBe(before + 1);
		// and the watchdog did not keep terminating the dead socket after close
		expect(ws.terminate).toHaveBeenCalledTimes(1);
	});

	it('e) regression: the existing 25s app HEARTBEAT still sends', () => {
		vi.useFakeTimers();
		// disable the watchdog's own timers so only the heartbeat fires in this window
		const { ws } = makeClient({ pingIntervalMs: 999999, deadAfterMs: 999999 });
		ws.emit('open');

		vi.advanceTimersByTime(25000);

		expect(ws.send).toHaveBeenCalledTimes(1);
		const frame = ws.send.mock.calls[0][0] as string;
		expect(JSON.parse(frame).type).toBe(2); // WSReqType.HEARTBEAT
	});
});
