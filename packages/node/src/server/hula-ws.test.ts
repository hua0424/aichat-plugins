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

describe('HulaWSClient reliability fixes (PR#67 P1)', () => {
	beforeEach(() => {
		hoisted.instances.length = 0;
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	// P1-3: startHeartbeat must clear any existing timer before creating a new one,
	// so a double-start (double 'open') can never orphan an interval.
	it('P1-3: double open does not leak a heartbeat interval', () => {
		vi.useFakeTimers();
		// disable the watchdog so only the heartbeat is exercised here
		const { ws } = makeClient({ pingIntervalMs: 999999, deadAfterMs: 999999 });
		ws.emit('open');
		ws.emit('open'); // second start must not orphan the first interval

		vi.advanceTimersByTime(25000);

		// exactly ONE heartbeat interval alive → one send, not two
		expect(ws.send).toHaveBeenCalledTimes(1);
	});

	// P1-3: startWatchdog must likewise be idempotent.
	it('P1-3: double open does not leak a watchdog interval', () => {
		vi.useFakeTimers();
		const { ws } = makeClient({ pingIntervalMs: 1000, deadAfterMs: 999999 });
		ws.emit('open');
		ws.emit('open'); // second start must not orphan the first interval

		vi.advanceTimersByTime(1000);

		// one watchdog interval → one ping per period, not two
		expect(ws.ping).toHaveBeenCalledTimes(1);
	});

	// P1-1/P1-3: after a real reconnect cycle only ONE watchdog interval is active,
	// and the previous socket's interval is dead (no doubled pings).
	it('P1-1: after a reconnect only one watchdog interval is active (no leak)', () => {
		vi.useFakeTimers();
		const { ws: ws1 } = makeClient({ pingIntervalMs: 1000, deadAfterMs: 999999 });
		ws1.emit('open');

		vi.advanceTimersByTime(2000);
		expect(ws1.ping).toHaveBeenCalledTimes(2);

		// the socket drops → 'close' stops ws1's timers and schedules a reconnect
		ws1.emit('close', 1006, Buffer.from('drop'));
		const ws1PingsAtClose = ws1.ping.mock.calls.length;

		// backoff (1000ms) fires the reconnect → a brand-new ws2
		vi.advanceTimersByTime(1000);
		const ws2 = hoisted.instances[hoisted.instances.length - 1] as MockWs;
		expect(ws2).not.toBe(ws1);
		ws2.emit('open');

		// three watchdog periods → exactly three pings on ws2 (single interval),
		// and the old ws1 interval stays dead (no extra pings after its close).
		vi.advanceTimersByTime(3000);
		expect(ws2.ping).toHaveBeenCalledTimes(3);
		expect(ws1.ping.mock.calls.length).toBe(ws1PingsAtClose);
	});

	// P1-4: two consecutive scheduleReconnect triggers (double close, or error+close)
	// must schedule EXACTLY ONE reconnect, never stack parallel timers.
	it('P1-4: two consecutive close events schedule exactly one reconnect', () => {
		vi.useFakeTimers();
		const { ws } = makeClient();
		ws.emit('open');
		const before = hoisted.instances.length;

		// both events reach scheduleReconnect
		ws.emit('close', 1006, Buffer.from('a'));
		ws.emit('close', 1006, Buffer.from('b'));

		// first backoff (1000ms): the single pending reconnect fires connect() once
		vi.advanceTimersByTime(1000);
		expect(hoisted.instances.length).toBe(before + 1);

		// a second (stacked) timer would have fired around the 2000ms mark — assert none did
		vi.advanceTimersByTime(2000);
		expect(hoisted.instances.length).toBe(before + 1);
	});

	// P1-5: deadAfterMs <= pingIntervalMs would false-kill a healthy connection;
	// the constructor clamps to pingIntervalMs*2 and warns once (no throw).
	it('P1-5: clamps deadAfterMs when <= pingIntervalMs and warns', () => {
		vi.useFakeTimers();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { ws } = makeClient({ pingIntervalMs: 30000, deadAfterMs: 10000 });
		ws.emit('open');

		// clamp warning emitted at construction, mentioning the correction
		expect(warn).toHaveBeenCalled();
		const logged = warn.mock.calls.flat().join(' ');
		expect(logged).toContain('clamping');
		expect(logged).toContain('10000');
		expect(logged).toContain('60000');

		// ping every 30000; half-open detection fires at the CLAMPED 60000, not 10000
		vi.advanceTimersByTime(30000); // tick 1: since=30000 < 60000 → ping only
		expect(ws.ping).toHaveBeenCalledTimes(1);
		expect(ws.terminate).not.toHaveBeenCalled();

		vi.advanceTimersByTime(30000); // tick 2 at 60000: since=60000 >= 60000 → terminate
		expect(ws.terminate).toHaveBeenCalledTimes(1);
	});

	// P1-2: a non-auth 'error' means the connection is going down — the liveness
	// timers must be stopped even though it is not the auth-failure branch.
	it('P1-2: a non-auth error stops the watchdog and heartbeat', () => {
		vi.useFakeTimers();
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const { ws } = makeClient(); // ping 1000, dead 3000
		ws.emit('open');

		// a generic transport error (NOT a handshake / auth failure)
		ws.emit('error', new Error('ECONNRESET socket hang up'));

		// both liveness timers stopped → no further ping / heartbeat as time passes,
		// and no watchdog-driven terminate on the (already dead) socket
		vi.advanceTimersByTime(25000);
		expect(ws.ping).not.toHaveBeenCalled();
		expect(ws.send).not.toHaveBeenCalled();
		expect(ws.terminate).not.toHaveBeenCalled();
	});
});

// #152 rewarm fix: a transient non-101 handshake response (e.g. HTTP 200 while the
// gateway's ws routes warm up after a restart / docker unpause) must NOT be classified
// as auth-fatal. Only genuine auth codes (401/403/406) permanently stop reconnect;
// everything else stays retryable through the existing 'close'(1006) → scheduleReconnect
// backoff. The real ws lib emits 'error' then 'close' on a failed handshake, so the tests
// drive both events in that order.
describe('HulaWSClient handshake reconnect classification (#152 rewarm)', () => {
	beforeEach(() => {
		hoisted.instances.length = 0;
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('200 transient → stays retryable: closed=false, reconnects via backoff, onAuthError NOT called', () => {
		vi.useFakeTimers();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const onAuthError = vi.fn(async () => true);
		const { client, ws } = makeClient({ onAuthError });
		ws.emit('open');
		const before = hoisted.instances.length;

		// gateway rewarm: upgrade answered with HTTP 200, then the ws lib's follow-up close(1006)
		ws.emit('error', new Error('Unexpected server response: 200'));
		ws.emit('close', 1006, Buffer.from('rewarm'));

		// core regression: this must NOT be treated as auth-fatal
		expect(client.closed).toBe(false);
		expect(onAuthError).not.toHaveBeenCalled();

		// the 'close' handler scheduled a backoff reconnect (1000ms) → a brand-new ws instance
		vi.advanceTimersByTime(1000);
		expect(hoisted.instances.length).toBe(before + 1);
	});

	it('401 still fatal: closed=true, onAuthError invoked, no plain-backoff reconnect when it returns false', async () => {
		vi.useFakeTimers();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const onAuthError = vi.fn(async () => false); // refresh failed → cannot retry
		const { client, ws } = makeClient({ onAuthError });
		ws.emit('open');
		const before = hoisted.instances.length;

		ws.emit('error', new Error('Unexpected server response: 401'));
		ws.emit('close', 1006, Buffer.from('auth'));

		// auth-fatal path: closed set immediately by the error handler
		expect(client.closed).toBe(true);

		// let the awaited onAuthError() microtask settle
		await vi.runAllTimersAsync();
		expect(onAuthError).toHaveBeenCalledTimes(1);

		// onAuthError returned false → no reconnect; the 'close' also saw closed=true so it
		// did not schedule a plain backoff reconnect either → no new socket
		expect(hoisted.instances.length).toBe(before);
	});

	it('401 fatal but onAuthError returns true → reconnects (unchanged behavior)', async () => {
		vi.useFakeTimers();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const onAuthError = vi.fn(async () => true); // token refreshed → retry ok
		const { client, ws } = makeClient({ onAuthError });
		ws.emit('open');
		const before = hoisted.instances.length;

		ws.emit('error', new Error('Unexpected server response: 401'));
		ws.emit('close', 1006, Buffer.from('auth'));

		await vi.runAllTimersAsync(); // onAuthError → closed=false + scheduleReconnect + backoff fires
		expect(onAuthError).toHaveBeenCalledTimes(1);
		expect(client.closed).toBe(false);
		expect(hoisted.instances.length).toBe(before + 1);
	});

	it('503 transient → stays retryable like 200 (proves it is not 200-specific)', () => {
		vi.useFakeTimers();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const onAuthError = vi.fn(async () => true);
		const { client, ws } = makeClient({ onAuthError });
		ws.emit('open');
		const before = hoisted.instances.length;

		ws.emit('error', new Error('Unexpected server response: 503'));
		ws.emit('close', 1006, Buffer.from('unavailable'));

		expect(client.closed).toBe(false);
		expect(onAuthError).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1000);
		expect(hoisted.instances.length).toBe(before + 1);
	});

	it('502 transient → stays retryable (extra transient code)', () => {
		vi.useFakeTimers();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { client, ws } = makeClient();
		ws.emit('open');
		const before = hoisted.instances.length;

		ws.emit('error', new Error('Unexpected server response: 502'));
		ws.emit('close', 1006, Buffer.from('bad gateway'));

		expect(client.closed).toBe(false);

		vi.advanceTimersByTime(1000);
		expect(hoisted.instances.length).toBe(before + 1);
	});
});
