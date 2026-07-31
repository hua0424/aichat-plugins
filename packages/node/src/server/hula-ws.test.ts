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

/**
 * #184 mock IncomingMessage for ws 'unexpected-response'(req, res).
 * Real ws passes the http.IncomingMessage; tests drive `fire()` to deliver body chunks
 * + end (in production the body is small and arrives near-instantly). `fire()` is
 * intentionally explicit so each test controls when the body lands relative to 'close'.
 */
interface MockRes {
	statusCode: number;
	on(event: 'data' | 'end' | 'error', cb: (...a: unknown[]) => void): MockRes;
	fire(): void;
}
function mockRes(statusCode: number, body: string): MockRes {
	const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
	return {
		statusCode,
		on(event, cb) {
			(handlers[event] ||= []).push(cb);
			return this;
		},
		fire() {
			for (const cb of handlers.data ?? []) cb(Buffer.from(body));
			for (const cb of handlers.end ?? []) cb();
		},
	};
}

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
// backoff.
//
// #184 migration: ws emits 'unexpected-response'(req, res) — NOT 'error' — once a
// listener for it is registered (verified ws@8.19). So the classification moved off the
// 'error' path and onto 'unexpected-response', and these tests drive that event with a
// mock IncomingMessage (statusCode + body delivered via mockRes().fire()).
describe('HulaWSClient handshake reconnect classification (#152 rewarm, #184 unexpected-response)', () => {
	beforeEach(() => {
		hoisted.instances.length = 0;
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('200 transient (empty body) → stays retryable: closed=false, reconnects via backoff, onAuthError NOT called', () => {
		vi.useFakeTimers();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const onAuthError = vi.fn(async () => true);
		const { client, ws } = makeClient({ onAuthError });
		ws.emit('open');
		const before = hoisted.instances.length;

		// gateway rewarm: upgrade answered with HTTP 200 + empty body
		const res = mockRes(200, '');
		ws.emit('unexpected-response', {}, res);
		res.fire();
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

		const res = mockRes(401, '');
		ws.emit('unexpected-response', {}, res);
		res.fire();
		ws.emit('close', 1006, Buffer.from('auth'));

		// auth-fatal path: closed set immediately by the classification
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

		const res = mockRes(401, '');
		ws.emit('unexpected-response', {}, res);
		res.fire();
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

		const res = mockRes(503, '');
		ws.emit('unexpected-response', {}, res);
		res.fire();
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

		const res = mockRes(502, '');
		ws.emit('unexpected-response', {}, res);
		res.fire();
		ws.emit('close', 1006, Buffer.from('bad gateway'));

		expect(client.closed).toBe(false);

		vi.advanceTimersByTime(1000);
		expect(hoisted.instances.length).toBe(before + 1);
	});
});

// #184 plugins hula-ws handshake 200 circuit breaker.
//
// Root cause: server gateway's TokenContextFilter.errorResponse deliberately wraps aiclaw
// token-validation failures as HTTP 200 + JSON body {success:false,code:406,msg:"token已过期"}.
// The old client only listened to 'error', parsed "Unexpected server response: 200" from
// err.message, and treated 200 as a transient rewarm → infinite backoff (codex retried
// silently for 43 minutes in production). Fix: handle 'unexpected-response', read the body,
// and classify a business-error body as PERMANENT (stop reconnect + WARN with uid/status/code).
describe('HulaWSClient handshake 200 circuit breaker (#184)', () => {
	beforeEach(() => {
		hoisted.instances.length = 0;
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	// tracer #1: the core regression — 200 + business-error JSON body must be PERMANENT.
	it('200 + body {success:false,code:406} → permanent: closed=true, onAuthError called, WARN carries uid+http+bizCode+msg', async () => {
		vi.useFakeTimers();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const onAuthError = vi.fn(async () => false);
		const { client, ws } = makeClient({ onAuthError, uid: 'u-42' });
		ws.emit('open');
		const before = hoisted.instances.length;

		const body = JSON.stringify({ success: false, code: 406, msg: 'token已过期' });
		const res = mockRes(200, body);
		ws.emit('unexpected-response', {}, res);
		res.fire();

		expect(client.closed).toBe(true);

		await vi.runAllTimersAsync();
		expect(onAuthError).toHaveBeenCalledTimes(1);

		// WARN-level report (the 43-min silence lesson): must include uid + http status + biz code + msg
		const logged = warn.mock.calls.flat().join(' ');
		expect(logged).toContain('u-42');
		expect(logged).toContain('200');
		expect(logged).toContain('406');
		expect(logged).toContain('token已过期');

		// permanent → no reconnect scheduled; follow-up 'close' must not re-arm one either
		ws.emit('close', 1006, Buffer.from('circuit'));
		vi.advanceTimersByTime(60000);
		expect(hoisted.instances.length).toBe(before);
	});

	// tracer #2: 200 with empty / non-JSON body is transient (genuine gateway rewarm).
	it('200 + non-JSON body → transient: closed=false, reconnects via backoff', () => {
		vi.useFakeTimers();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const onAuthError = vi.fn(async () => false);
		const { client, ws } = makeClient({ onAuthError });
		ws.emit('open');
		const before = hoisted.instances.length;

		const res = mockRes(200, 'nginx rewarming, not json');
		ws.emit('unexpected-response', {}, res);
		res.fire();
		ws.emit('close', 1006, Buffer.from('rewarm'));

		expect(client.closed).toBe(false);
		expect(onAuthError).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1000);
		expect(hoisted.instances.length).toBe(before + 1);
	});

	// tracer #3: classic auth codes (401) stay permanent even without a business body
	// (preserves the pre-#184 AUTH_FATAL behavior; body just makes 200 fatal too).
	it('401 without body → permanent (preserves AUTH_FATAL statusCode behavior)', async () => {
		vi.useFakeTimers();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const onAuthError = vi.fn(async () => false);
		const { client, ws } = makeClient({ onAuthError });
		ws.emit('open');

		const res = mockRes(401, '');
		ws.emit('unexpected-response', {}, res);
		res.fire();

		expect(client.closed).toBe(true);
		await vi.runAllTimersAsync();
		expect(onAuthError).toHaveBeenCalledTimes(1);
	});

	// tracer #4: gateway 5xx without a business body is transient.
	it('503 + empty body → transient, retryable', () => {
		vi.useFakeTimers();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { client, ws } = makeClient();
		ws.emit('open');
		const before = hoisted.instances.length;

		const res = mockRes(503, '');
		ws.emit('unexpected-response', {}, res);
		res.fire();
		ws.emit('close', 1006, Buffer.from('unavailable'));

		expect(client.closed).toBe(false);
		vi.advanceTimersByTime(1000);
		expect(hoisted.instances.length).toBe(before + 1);
	});

	// tracer #5: N consecutive transient handshake failures → threshold WARN (suspected gateway outage).
	it('N consecutive transient failures → threshold WARN fires (and stays retryable, not permanent)', () => {
		vi.useFakeTimers();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { client, ws } = makeClient({ uid: 'u-7' });
		ws.emit('open');

		// default threshold is 10
		for (let i = 0; i < 10; i++) {
			const res = mockRes(502, '');
			ws.emit('unexpected-response', {}, res);
			res.fire();
			ws.emit('close', 1006, Buffer.from('bad-gw'));
			// advance past the backoff so the next attempt's ws is the current one
			vi.advanceTimersByTime(1000 << i > 30000 ? 30000 : 1000 << i);
		}

		const logged = warn.mock.calls.flat().join(' ');
		expect(logged).toContain('suspected gateway'); // threshold alert copy
		expect(logged).toContain('u-7');
		// NOT permanent — gateway may recover, so keep retrying
		expect(client.closed).toBe(false);
	});

	// tracer #6: a successful connect after a few transient failures resets the counter
	// (no false-positive threshold WARN on later transient bursts).
	it('transient failures then success → counter resets (no false threshold WARN on a later burst)', () => {
		vi.useFakeTimers();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { ws } = makeClient({ uid: 'u-9' });
		ws.emit('open');

		// 3 transient failures (below threshold of 10)
		for (let i = 0; i < 3; i++) {
			const res = mockRes(503, '');
			ws.emit('unexpected-response', {}, res);
			res.fire();
			ws.emit('close', 1006, Buffer.from('unavail'));
			vi.advanceTimersByTime(Math.min(1000 << i, 30000));
		}

		// a fresh connect succeeds → 'open' resets the transient counter
		const recovered = hoisted.instances[hoisted.instances.length - 1] as MockWs;
		recovered.emit('open');
		warn.mockClear();

		// now another 3 transient failures (post-reset) — below threshold, no alert
		for (let i = 0; i < 3; i++) {
			const res = mockRes(503, '');
			recovered.emit('unexpected-response', {}, res);
			res.fire();
			recovered.emit('close', 1006, Buffer.from('unavail'));
			vi.advanceTimersByTime(Math.min(1000 << i, 30000));
		}

		const logged = warn.mock.calls.flat().join(' ');
		expect(logged).not.toContain('suspected gateway');
	});

	// extra: the race where ws fires 'close' BEFORE the body is fully read must not
	// race ahead and schedule a redundant reconnect on a permanent failure.
	it('permanent failure: close fired before body-end → still permanent, no reconnect scheduled', async () => {
		vi.useFakeTimers();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const onAuthError = vi.fn(async () => false);
		const { client, ws } = makeClient({ onAuthError });
		ws.emit('open');
		const before = hoisted.instances.length;

		const res = mockRes(200, JSON.stringify({ success: false, code: 406, msg: 'x' }));
		// 'close' arrives BEFORE body-end (pending flag must hold off scheduleReconnect)
		ws.emit('unexpected-response', {}, res);
		ws.emit('close', 1006, Buffer.from('race'));
		res.fire();

		expect(client.closed).toBe(true);
		await vi.runAllTimersAsync();
		vi.advanceTimersByTime(60000);
		expect(hoisted.instances.length).toBe(before);
	});
});
