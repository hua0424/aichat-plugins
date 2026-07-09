import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import {
	OpenclawDriver,
	filterOpenclawThinking,
	OPENCLAW_EMPTY_THINKING_PLACEHOLDER,
	buildConnectParams,
	parseHelloOk,
} from './openclaw-driver.js';
import type { AgentEvent } from '../events.js';
import { InMemoryBindTokenStore } from '../bind-token-store.js';

/** A deterministic bind-token store: tokens are `tok-1`, `tok-2`, … so assertions are stable. */
function makeStore(): InMemoryBindTokenStore {
	let n = 0;
	return new InMemoryBindTokenStore(() => `tok-${++n}`);
}

async function drain(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
	const out: AgentEvent[] = [];
	for await (const ev of stream) out.push(ev);
	return out;
}

/**
 * A fake gateway WebSocket the driver's engine drives against a scripted server, so the SAME
 * scenarios the old adapter-fake tests scripted (assistant deltas → thinking, lifecycle end → done,
 * lifecycle error → error) run through the REAL AgentDriver interface without a live socket.
 *
 * The socket is a plain EventEmitter with send()/close(); the gateway logic auto-completes the
 * connect handshake (open → connect.challenge → connect req → hello-ok) and answers each `agent` req
 * with an `accepted` + runId, then lets the test emit that run's stream frames.
 */
class FakeSocket extends EventEmitter {
	sent: unknown[] = [];
	closed = false;
	onSend?: (frame: Record<string, unknown>) => void;
	send(data: string): void {
		const frame = JSON.parse(data);
		this.sent.push(frame);
		this.onSend?.(frame);
	}
	close(code = 1000, reason = ''): void {
		if (this.closed) return;
		this.closed = true;
		this.emit('close', code, Buffer.from(reason));
	}
	deliver(frame: unknown): void {
		this.emit('message', Buffer.from(JSON.stringify(frame)));
	}
}

function fakeGateway() {
	const socket = new FakeSocket();
	let runCounter = 0;
	let lastRunId = '';
	let lastAgentSessionKey: string | undefined;
	let seq = 0;

	socket.onSend = (frame) => {
		if (frame.method === 'connect') {
			// hello-ok: negotiate v4 with a tick interval.
			queueMicrotask(() =>
				socket.deliver({
					type: 'res',
					id: frame.id,
					ok: true,
					payload: { type: 'hello-ok', protocol: 4, server: { version: 'test', connId: 'c1' }, policy: { tickIntervalMs: 30000 } },
				}),
			);
		} else if (frame.method === 'agent') {
			const runId = `run-${++runCounter}`;
			lastRunId = runId;
			lastAgentSessionKey = (frame.params as { sessionKey?: string }).sessionKey;
			queueMicrotask(() => socket.deliver({ type: 'res', id: frame.id, ok: true, payload: { status: 'accepted', runId } }));
		}
	};

	const emitAgent = (stream: string, data: Record<string, unknown>) => {
		socket.deliver({ type: 'event', event: 'agent', payload: { runId: lastRunId, seq: ++seq, stream, ts: Date.now(), data } });
	};

	return {
		socket,
		// Factory the driver constructor receives. Emits 'open' + the connect.challenge on a microtask
		// so the driver's synchronously-attached handlers are in place first (mirrors the real ws).
		factory: (): WebSocket => {
			queueMicrotask(() => {
				socket.emit('open');
				socket.deliver({ type: 'event', event: 'connect.challenge', payload: { nonce: 'nonce-1' } });
			});
			return socket as unknown as WebSocket;
		},
		lastSessionKey: () => lastAgentSessionKey,
		emitDelta: (text: string) => emitAgent('assistant', { delta: text }),
		emitEnd: () => emitAgent('lifecycle', { phase: 'end' }),
		emitError: (message: string) => emitAgent('lifecycle', { phase: 'error', error: message }),
	};
}

/** A connected driver + its fake gateway, plus the store, for the stream tests. */
async function connectedDriver(store = makeStore()) {
	const gw = fakeGateway();
	const driver = new OpenclawDriver('ws://localhost:18789', '', store, gw.factory);
	await driver.connect();
	return { driver, gw, store };
}

describe('OpenclawDriver — lifecycle', () => {
	it('connect drives the gateway handshake; disconnect tears it down', async () => {
		const { driver, gw } = await connectedDriver();
		expect(driver.isConnected).toBe(true);
		await driver.disconnect();
		expect(driver.isConnected).toBe(false);
		expect(gw.socket.closed).toBe(true);
	});
});

describe('OpenclawDriver — session keying', () => {
	it('openSession sends the COMPOUND `<token>:<binding>` to the gateway; resolveSession reverses the BARE token only', async () => {
		const { driver, gw } = await connectedDriver();
		const session = await driver.openSession({ aiclawUid: '999', roomId: '7', chatContext: {} });
		const stream = session.send('hi');
		gw.emitEnd();
		await drain(stream);
		// #141 B+ regression fix: the value handed to the openclaw gateway is a COMPOUND sessionKey —
		// the opaque token FIRST, a literal `:`, then the plaintext binding LAST. The tail binding keeps
		// openclaw's gateway-side conversation key stable per room; the prefix token lets the CLI/exec-env
		// path recover an unforgeable token.
		expect(gw.lastSessionKey()).toBe('tok-1:aiclaw-999-room-7');
		// still NOT the bare guessable plaintext binding on its own.
		expect(gw.lastSessionKey()).not.toBe('aiclaw-999-room-7');
		// resolveSession is an EXACT store lookup of the BARE token — it must NOT split the compound.
		expect(driver.resolveSession('tok-1')).toEqual({ aiclawUid: '999', roomId: '7' });
		// the compound itself is NOT a stored key → forgery (or an accidental compound arriving at the
		// endpoint) misses the store → undefined. The compound only legitimately lives gateway-side.
		expect(driver.resolveSession('tok-1:aiclaw-999-room-7')).toBeUndefined();
		await driver.disconnect();
	});

	it('confinement: the compound sessionKey is used ONLY at the gateway, never as a node-internal key', async () => {
		// #141 B+ manager hard requirement #2: the compound must stay confined to the gateway `agent`
		// req — the node-side thinking sessionKey is computed independently from (uid,room) in the
		// message handler, and openclaw has no transcript/registry/session_id store (those are cc-only).
		// So the ONLY place the compound appears is the gateway request; resolveSession keys on the bare
		// token alone.
		const { driver, gw } = await connectedDriver();
		const session = await driver.openSession({ aiclawUid: '5', roomId: '9', chatContext: {} });
		const stream = session.send('hi');
		gw.emitEnd();
		await drain(stream);
		const compound = 'tok-1:aiclaw-5-room-9';
		// the gateway saw the compound…
		expect(gw.lastSessionKey()).toBe(compound);
		// …but the driver never treats the compound as a keying value: neither resolveSession nor
		// resetSession recognise it (resolveSession → undefined, resetSession is a flat no-op).
		expect(driver.resolveSession(compound)).toBeUndefined();
		expect(driver.resetSession()).toBe(false);
		await driver.disconnect();
	});
});

describe('OpenclawDriver — abandoned-run backstop (aichatoverview#166)', () => {
	type Maps = { activeChats: Map<string, unknown>; pending: Map<string, unknown>; requestToRunId: Map<string, unknown> };
	const flush = async () => {
		await Promise.resolve();
		await Promise.resolve();
	};

	it('a run the gateway never terminates → 5-min backstop finishes the stream + reclaims all three maps', async () => {
		vi.useFakeTimers();
		try {
			const { driver } = await connectedDriver();
			const session = await driver.openSession({ aiclawUid: '1', roomId: '1', chatContext: {} as never });
			const stream = session.send('hi');
			await flush(); // let the gateway's `accepted`+runId res land (links run:, deletes pending)

			const maps = driver as unknown as Maps;
			expect(maps.activeChats.size).toBeGreaterThan(0); // the in-flight turn is tracked

			vi.advanceTimersByTime(5 * 60 * 1000 + 1); // gateway never sent end/error → backstop fires
			const events = await drain(stream);

			expect(events.some((e) => e.type === 'error')).toBe(true); // consumer unblocked with an error
			expect(maps.activeChats.size).toBe(0); // three maps reclaimed
			expect(maps.pending.size).toBe(0);
			expect(maps.requestToRunId.size).toBe(0);
			await driver.disconnect();
		} finally {
			vi.useRealTimers();
		}
	});

	it('normal termination (lifecycle end) clears the backstop — no late error, maps already clean', async () => {
		vi.useFakeTimers();
		try {
			const { driver, gw } = await connectedDriver();
			const session = await driver.openSession({ aiclawUid: '1', roomId: '1', chatContext: {} as never });
			const stream = session.send('hi');
			await flush();
			gw.emitEnd();
			const events = await drain(stream);

			expect(events.some((e) => e.type === 'done')).toBe(true);
			expect(events.some((e) => e.type === 'error')).toBe(false);
			const maps = driver as unknown as Maps;
			expect(maps.activeChats.size).toBe(0);

			// advancing past the backstop window must NOT resurrect an error (the timer was cleared on end)
			const before = events.length;
			vi.advanceTimersByTime(5 * 60 * 1000 + 1);
			await flush();
			expect(events.length).toBe(before);
			await driver.disconnect();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('OpenclawDriver — stream mapping', () => {
	// REQ-010 S1: the terminal AgentEvent is retired. The openclaw agent still sends its reply
	// internally (via `aichat send-message`), so the stream carries only thinking + done/error.
	it('send: thinking deltas + lifecycle end → mapped AgentEvent sequence (terminal NOT bridged)', async () => {
		const { driver, gw } = await connectedDriver();
		const session = await driver.openSession({ aiclawUid: '1', roomId: '1', chatContext: {} });
		const stream = session.send('m');
		gw.emitDelta('foo');
		gw.emitDelta('bar');
		gw.emitEnd();
		const events = await drain(stream);
		expect(events).toEqual([
			{ type: 'thinking', text: 'foo' },
			{ type: 'thinking', text: 'bar' },
			{ type: 'done', durationMs: expect.any(Number) },
		]);
		await driver.disconnect();
	});

	it('skip: no deltas, only lifecycle end → just done reaches the stream', async () => {
		const { driver, gw } = await connectedDriver();
		const session = await driver.openSession({ aiclawUid: '1', roomId: '1', chatContext: {} });
		const stream = session.send('m');
		gw.emitEnd();
		const events = await drain(stream);
		expect(events).toEqual([{ type: 'done', durationMs: expect.any(Number) }]);
		await driver.disconnect();
	});

	it('error: lifecycle phase=error → error event then iterator ends', async () => {
		const { driver, gw } = await connectedDriver();
		const session = await driver.openSession({ aiclawUid: '1', roomId: '1', chatContext: {} });
		const stream = session.send('m');
		gw.emitDelta('partial');
		gw.emitError('boom');
		const events = await drain(stream);
		expect(events).toEqual([
			{ type: 'thinking', text: 'partial' },
			{ type: 'error', message: 'boom' },
		]);
		await driver.disconnect();
	});

	it('buffer correctness: events fired synchronously before the consumer awaits are not lost', async () => {
		// The gateway fires ALL of a turn's frames before send()'s consumer starts iterating.
		// The push→pull queue must replay every buffered event.
		const { driver, gw } = await connectedDriver();
		const session = await driver.openSession({ aiclawUid: '1', roomId: '1', chatContext: {} });
		const stream = session.send('m');
		gw.emitDelta('a');
		gw.emitDelta('b');
		gw.emitEnd();
		// Yield a macrotask so everything is buffered first.
		await new Promise((r) => setImmediate(r));
		const events = await drain(stream);
		expect(events).toEqual([
			{ type: 'thinking', text: 'a' },
			{ type: 'thinking', text: 'b' },
			{ type: 'done', durationMs: expect.any(Number) },
		]);
		await driver.disconnect();
	});

	it('close() lets a stuck iterator terminate', async () => {
		// The gateway sends a delta but never a terminal lifecycle frame; close() must end the stream.
		const { driver, gw } = await connectedDriver();
		const session = await driver.openSession({ aiclawUid: '1', roomId: '1', chatContext: {} });
		const stream = session.send('m');
		gw.emitDelta('hanging'); // no end/error
		const collected: AgentEvent[] = [];
		const consumer = (async () => {
			for await (const ev of stream) {
				collected.push(ev);
				if (ev.type === 'thinking') {
					// after first event, close → next await should resolve and end
					await session.close();
				}
			}
		})();
		await consumer;
		expect(collected).toEqual([{ type: 'thinking', text: 'hanging' }]);
		await driver.disconnect();
	});

	it('close() wakes a consumer parked in await (close-during-await)', async () => {
		// The gateway sends NOTHING terminal → the iterator immediately parks on the await with an
		// empty buffer. close() must wake that parked promise so the for-await completes (done).
		const { driver } = await connectedDriver();
		const session = await driver.openSession({ aiclawUid: '1', roomId: '1', chatContext: {} });
		const stream = session.send('m'); // no stream frames emitted

		const collected: AgentEvent[] = [];
		const consumed = (async () => {
			for await (const ev of stream) collected.push(ev);
		})();

		// Give the consumer a tick to reach the parked await, then close.
		await new Promise((r) => setImmediate(r));
		await session.close();

		// Timeout guard: a regression (hang) loses the race and fails the test instead of hanging.
		const timeout = new Promise<never>((_, reject) => {
			const t = setTimeout(() => reject(new Error('iterator did not terminate after close()')), 1000);
			if (typeof t === 'object' && 'unref' in t) (t as { unref: () => void }).unref();
		});
		await Promise.race([consumed, timeout]);

		// No terminal event was ever pushed → the loop completed with nothing collected.
		expect(collected).toEqual([]);
		await driver.disconnect();
	});
});

describe('OpenclawDriver.resolveSession (BL-014 #141 — opaque token store lookup)', () => {
	// The OPENCLAW_BIND value is now a node-minted OPAQUE token; resolveBoundSession strips the
	// `openclaw:` prefix upstream, so resolveSession receives the bare token and LOOKS IT UP in the
	// store (no longer a parse — the plaintext binding is never trusted from the agent's env).
	function driverWithStore() {
		const store = makeStore();
		// No socket work here — resolveSession/openSession(mint) never touch the gateway.
		return { driver: new OpenclawDriver('ws://localhost:18789', '', store), store };
	}

	it('a MINTED token → { aiclawUid, roomId } (exact opaque strings, REQ-029)', async () => {
		const { driver } = driverWithStore();
		// mint happens on openSession; a >2^53 uid/room must survive as an EXACT string.
		await driver.openSession({ aiclawUid: '9007199254740993', roomId: '9007199254740994', chatContext: {} });
		expect(driver.resolveSession('tok-1')).toEqual({
			aiclawUid: '9007199254740993',
			roomId: '9007199254740994',
		});
	});

	it('a FORGED plaintext binding (never minted) → undefined (anti-forgery: cannot impersonate)', () => {
		const { driver } = driverWithStore();
		// what an agent gets by overwriting OPENCLAW_BIND with a guessed (uid,room) — not a minted token.
		expect(driver.resolveSession('aiclaw-999-room-888')).toBeUndefined();
		expect(driver.resolveSession('aiclaw-7-room-42')).toBeUndefined();
	});

	it('a COMPOUND `<token>:<binding>` (never stored as one key) → undefined (endpoint must not split it)', async () => {
		const { driver } = driverWithStore();
		await driver.openSession({ aiclawUid: '999', roomId: '888', chatContext: {} });
		// the bare minted token resolves…
		expect(driver.resolveSession('tok-1')).toEqual({ aiclawUid: '999', roomId: '888' });
		// …but the compound (what an attacker might forge by appending a binding tail to a token) is NOT
		// a stored key → exact lookup misses → undefined. resolveSession NEVER splits on `:`.
		expect(driver.resolveSession('tok-1:aiclaw-999-room-888')).toBeUndefined();
	});

	it('a still-`openclaw:`-prefixed input (prefix stripped upstream) → undefined', () => {
		const { driver } = driverWithStore();
		expect(driver.resolveSession('openclaw:tok-1')).toBeUndefined();
	});

	it('garbage / empty → undefined', () => {
		const { driver } = driverWithStore();
		expect(driver.resolveSession('garbage')).toBeUndefined();
		expect(driver.resolveSession('')).toBeUndefined();
	});
});

describe('OpenclawDriver.resetSession (aichatoverview#124)', () => {
	it('returns false (no per-room store — binding IS the session) and does not throw', () => {
		const d = new OpenclawDriver('ws://localhost:18789', '', makeStore());
		expect(d.resetSession()).toBe(false);
	});
});

describe('filterOpenclawThinking — openclaw NO_REPLY sentinel + empty thinking', () => {
	// ① pure sentinel → placeholder
	it('replaces a bare NO_REPLY with the placeholder', () => {
		expect(filterOpenclawThinking('NO_REPLY')).toBe(OPENCLAW_EMPTY_THINKING_PLACEHOLDER);
	});

	// ② sentinel with surrounding whitespace → placeholder (whole-string regex allows \s)
	it('replaces NO_REPLY with leading/trailing whitespace', () => {
		expect(filterOpenclawThinking('  NO_REPLY\n')).toBe(OPENCLAW_EMPTY_THINKING_PLACEHOLDER);
		expect(filterOpenclawThinking('\n NO_REPLY ')).toBe(OPENCLAW_EMPTY_THINKING_PLACEHOLDER);
	});

	// ③ a real thought CONTAINING the substring → returned UNCHANGED (verbatim)
	it('preserves a real thought that merely contains the substring', () => {
		const a = '我判断这条不用回复，本想输出 NO_REPLY 但其实要答';
		const b = 'NO_REPLY_HANDLER 是个变量名';
		expect(filterOpenclawThinking(a)).toBe(a);
		expect(filterOpenclawThinking(b)).toBe(b);
	});

	// ④ guard documentation: a plain non-sentinel thought passes through untouched (no-op),
	// so any non-openclaw driver — which never calls this at all — is unaffected by construction.
	it('is a no-op for an ordinary non-sentinel thought', () => {
		expect(filterOpenclawThinking('普通思考正文')).toBe('普通思考正文');
	});

	// ⑤ empty string → placeholder (openclaw's purely-empty assistant stream)
	it('replaces an empty string with the placeholder', () => {
		expect(filterOpenclawThinking('')).toBe(OPENCLAW_EMPTY_THINKING_PLACEHOLDER);
	});

	// ⑥ whitespace-only → placeholder
	it('replaces whitespace-only thinking with the placeholder', () => {
		expect(filterOpenclawThinking('   ')).toBe(OPENCLAW_EMPTY_THINKING_PLACEHOLDER);
		expect(filterOpenclawThinking('\n\t ')).toBe(OPENCLAW_EMPTY_THINKING_PLACEHOLDER);
	});

	// stateless: repeated calls on the same non-global regex never drift (no lastIndex).
	it('is stateless across repeated calls', () => {
		expect(filterOpenclawThinking('NO_REPLY')).toBe(OPENCLAW_EMPTY_THINKING_PLACEHOLDER);
		expect(filterOpenclawThinking('NO_REPLY')).toBe(OPENCLAW_EMPTY_THINKING_PLACEHOLDER);
	});
});

describe('buildConnectParams', () => {
	const baseDevice = {
		id: 'device-123',
		publicKey: 'pubkey',
		signature: 'sig',
		signedAt: 1700000000000,
		nonce: 'nonce-abc',
	};

	const role = 'operator';
	const scopes = ['operator.admin', 'operator.read'];
	const platform = 'linux';

	it('negotiates protocol v4 (min and max)', () => {
		const params = buildConnectParams({
			token: 'tok',
			device: baseDevice,
			role,
			scopes,
			platform,
		});
		expect(params.minProtocol).toBe(4);
		expect(params.maxProtocol).toBe(4);
	});

	it('builds the client block with backend mode and aichat-node displayName', () => {
		const params = buildConnectParams({
			token: 'tok',
			device: baseDevice,
			role,
			scopes,
			platform,
		});
		const client = params.client as Record<string, unknown>;
		expect(client.mode).toBe('backend');
		expect(client.displayName).toBe('aichat-node');
		expect(client.id).toBe('gateway-client');
		expect(client.platform).toBe(platform);
	});

	it('includes device and auth when token present', () => {
		const params = buildConnectParams({
			token: 'tok',
			device: baseDevice,
			role,
			scopes,
			platform,
		});
		expect(params.device).toBe(baseDevice);
		expect(params.auth).toEqual({ token: 'tok' });
		expect(params.role).toBe(role);
		expect(params.scopes).toBe(scopes);
	});

	it('omits auth when no token', () => {
		const params = buildConnectParams({
			token: '',
			device: baseDevice,
			role,
			scopes,
			platform,
		});
		expect(params.auth).toBeUndefined();
	});

	it('omits auth when token undefined', () => {
		const params = buildConnectParams({
			device: baseDevice,
			role,
			scopes,
			platform,
		});
		expect(params.auth).toBeUndefined();
	});

	it('passes through undefined device', () => {
		const params = buildConnectParams({
			token: 'tok',
			device: undefined,
			role,
			scopes,
			platform,
		});
		expect(params.device).toBeUndefined();
	});
});

describe('parseHelloOk', () => {
	it('parses a valid v4 hello-ok', () => {
		const result = parseHelloOk({
			type: 'hello-ok',
			protocol: 4,
			server: { version: '2026.6.5', connId: 'abc' },
			policy: { tickIntervalMs: 15000 },
		});
		expect(result).toEqual({
			ok: true,
			protocol: 4,
			connId: 'abc',
			version: '2026.6.5',
			tickIntervalMs: 15000,
		});
	});

	it('parses a v3-style hello-ok with no protocol/connId', () => {
		const result = parseHelloOk({
			type: 'hello-ok',
			server: { version: 'x' },
		});
		expect(result.ok).toBe(true);
		expect(result.version).toBe('x');
		expect(result.protocol).toBeUndefined();
		expect(result.connId).toBeUndefined();
		expect(result.tickIntervalMs).toBeUndefined();
	});

	it('returns ok:true with no tickIntervalMs when policy missing', () => {
		const result = parseHelloOk({
			type: 'hello-ok',
			protocol: 4,
			server: { version: '2026.6.5', connId: 'abc' },
		});
		expect(result.ok).toBe(true);
		expect(result.tickIntervalMs).toBeUndefined();
		expect(result.protocol).toBe(4);
		expect(result.connId).toBe('abc');
	});

	it('ignores non-number tickIntervalMs', () => {
		const result = parseHelloOk({
			type: 'hello-ok',
			server: { version: 'x' },
			policy: { tickIntervalMs: 'fast' },
		});
		expect(result.ok).toBe(true);
		expect(result.tickIntervalMs).toBeUndefined();
	});

	it('ignores NaN tickIntervalMs', () => {
		const result = parseHelloOk({
			type: 'hello-ok',
			server: { version: 'x' },
			policy: { tickIntervalMs: NaN },
		});
		expect(result.ok).toBe(true);
		expect(result.tickIntervalMs).toBeUndefined();
	});

	it('ignores Infinity tickIntervalMs', () => {
		const result = parseHelloOk({
			type: 'hello-ok',
			server: { version: 'x' },
			policy: { tickIntervalMs: Infinity },
		});
		expect(result.ok).toBe(true);
		expect(result.tickIntervalMs).toBeUndefined();
	});

	it('ignores zero tickIntervalMs', () => {
		const result = parseHelloOk({
			type: 'hello-ok',
			server: { version: 'x' },
			policy: { tickIntervalMs: 0 },
		});
		expect(result.ok).toBe(true);
		expect(result.tickIntervalMs).toBeUndefined();
	});

	it('ignores negative tickIntervalMs', () => {
		const result = parseHelloOk({
			type: 'hello-ok',
			server: { version: 'x' },
			policy: { tickIntervalMs: -1 },
		});
		expect(result.ok).toBe(true);
		expect(result.tickIntervalMs).toBeUndefined();
	});

	it('accepts a valid positive tickIntervalMs', () => {
		const result = parseHelloOk({
			type: 'hello-ok',
			server: { version: 'x' },
			policy: { tickIntervalMs: 15000 },
		});
		expect(result.ok).toBe(true);
		expect(result.tickIntervalMs).toBe(15000);
	});

	it('treats empty-string connId as absent', () => {
		const result = parseHelloOk({
			type: 'hello-ok',
			protocol: 4,
			server: { version: 'x', connId: '' },
		});
		expect(result.ok).toBe(true);
		expect(result.connId).toBeUndefined();
	});

	it('ignores non-integer protocol and non-string connId', () => {
		const result = parseHelloOk({
			type: 'hello-ok',
			protocol: 'four',
			server: { version: 'x', connId: 123 },
		});
		expect(result.ok).toBe(true);
		expect(result.protocol).toBeUndefined();
		expect(result.connId).toBeUndefined();
	});

	it('returns ok:false for wrong type res', () => {
		expect(parseHelloOk({ type: 'res' })).toEqual({ ok: false });
	});

	it('returns ok:false for empty object', () => {
		expect(parseHelloOk({})).toEqual({ ok: false });
	});

	it('returns ok:false for null', () => {
		expect(parseHelloOk(null)).toEqual({ ok: false });
	});

	it('returns ok:false for undefined', () => {
		expect(parseHelloOk(undefined)).toEqual({ ok: false });
	});

	it('handles hello-ok with missing server block', () => {
		const result = parseHelloOk({ type: 'hello-ok', protocol: 4 });
		expect(result.ok).toBe(true);
		expect(result.protocol).toBe(4);
		expect(result.version).toBeUndefined();
		expect(result.connId).toBeUndefined();
	});
});
