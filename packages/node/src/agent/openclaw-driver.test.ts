import { describe, it, expect, vi } from 'vitest';
import {
	OpenclawDriver,
	filterOpenclawThinking,
	OPENCLAW_EMPTY_THINKING_PLACEHOLDER,
} from './openclaw-driver.js';
import type { ClawAdapter, ThinkingCallbacks, ChatContext } from '../claw/interface.js';
import type { AgentEvent } from './events.js';
import { InMemoryBindTokenStore } from './bind-token-store.js';

/** A deterministic bind-token store: tokens are `tok-1`, `tok-2`, … so assertions are stable. */
function makeStore(): InMemoryBindTokenStore {
	let n = 0;
	return new InMemoryBindTokenStore(() => `tok-${++n}`);
}

/**
 * Fake ClawAdapter whose chat() invokes a per-test script of callbacks. The
 * script runs either synchronously (before the consumer awaits) or asynchronously
 * to exercise buffer correctness.
 */
function fakeAdapter(script: (cb: ThinkingCallbacks) => void | Promise<void>) {
	const calls: Array<{ message: string; sessionKey: string; context?: ChatContext }> = [];
	const adapter = {
		type: 'openclaw',
		connect: vi.fn().mockResolvedValue(undefined),
		disconnect: vi.fn().mockResolvedValue(undefined),
		get isConnected() {
			return true;
		},
		chat: vi.fn(async (message: string, sessionKey: string, callbacks: ThinkingCallbacks, context?: ChatContext) => {
			calls.push({ message, sessionKey, context });
			await script(callbacks);
		}),
	} as unknown as ClawAdapter & { chat: ReturnType<typeof vi.fn> };
	return { adapter, calls };
}

async function drain(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
	const out: AgentEvent[] = [];
	for await (const ev of stream) out.push(ev);
	return out;
}

describe('OpenclawDriver', () => {
	it('connect/disconnect delegate to the adapter', async () => {
		const { adapter } = fakeAdapter(() => {});
		const driver = new OpenclawDriver(adapter, makeStore());
		await driver.connect();
		await driver.disconnect();
		expect((adapter.connect as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
		expect((adapter.disconnect as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
	});

	it('openSession mints an OPAQUE token as the sessionKey (NOT the plaintext binding); resolveSession reverses it', async () => {
		const { adapter, calls } = fakeAdapter((cb) => {
			cb.onThinkingEnd(10);
		});
		const store = makeStore();
		const driver = new OpenclawDriver(adapter, store);
		const session = await driver.openSession({ aiclawUid: '999', roomId: '7', chatContext: {} });
		await drain(session.send('hi'));
		// BL-014 (#141): the value handed to the openclaw agent is the minted token, never the guessable
		// plaintext `aiclaw-999-room-7` (which an agent could forge by overwriting OPENCLAW_BIND).
		expect(calls[0].sessionKey).toBe('tok-1');
		expect(calls[0].sessionKey).not.toBe('aiclaw-999-room-7');
		// the token round-trips back to the real (uid,room) via the store lookup.
		expect(driver.resolveSession!('tok-1')).toEqual({ aiclawUid: '999', roomId: '7' });
		expect(calls[0].context).toEqual({ roomId: '7' });
		expect(calls[0].message).toBe('hi');
	});

	// REQ-010 S1: the terminal AgentEvent is retired. onTerminalTool is NO LONGER bridged into the
	// stream (the openclaw adapter still sends its reply internally inside the gateway). The stream
	// now carries only thinking + done/error.
	it('send: thinking deltas + done → mapped AgentEvent sequence (terminal NOT bridged)', async () => {
		const { adapter } = fakeAdapter((cb) => {
			cb.onThinkingDelta('foo');
			cb.onThinkingDelta('bar');
			// onTerminalTool is no longer provided by the driver → adapter never calls it (retired).
			cb.onThinkingEnd(123);
		});
		const driver = new OpenclawDriver(adapter, makeStore());
		const session = await driver.openSession({ aiclawUid: '1', roomId: '1', chatContext: {} });
		const events = await drain(session.send('m'));
		expect(events).toEqual([
			{ type: 'thinking', text: 'foo' },
			{ type: 'thinking', text: 'bar' },
			{ type: 'done', durationMs: 123 },
		]);
	});

	it('skip: onTerminalTool not bridged; only done reaches the stream', async () => {
		const { adapter } = fakeAdapter((cb) => {
			// driver provides no onTerminalTool; a skip turn just ends with done.
			cb.onThinkingEnd(50);
		});
		const driver = new OpenclawDriver(adapter, makeStore());
		const session = await driver.openSession({ aiclawUid: '1', roomId: '1', chatContext: {} });
		const events = await drain(session.send('m'));
		expect(events).toEqual([{ type: 'done', durationMs: 50 }]);
	});

	it('error: onError → error event then iterator ends', async () => {
		const { adapter } = fakeAdapter((cb) => {
			cb.onThinkingDelta('partial');
			cb.onError(new Error('boom'));
		});
		const driver = new OpenclawDriver(adapter, makeStore());
		const session = await driver.openSession({ aiclawUid: '1', roomId: '1', chatContext: {} });
		const events = await drain(session.send('m'));
		expect(events).toEqual([
			{ type: 'thinking', text: 'partial' },
			{ type: 'error', message: 'boom' },
		]);
	});

	it('buffer correctness: events fired synchronously before the consumer awaits are not lost', async () => {
		// chat fires ALL callbacks synchronously and returns before send()'s consumer
		// starts iterating. The push→pull queue must replay every buffered event.
		const { adapter } = fakeAdapter((cb) => {
			cb.onThinkingDelta('a');
			cb.onThinkingDelta('b');
			cb.onThinkingEnd(7);
		});
		const driver = new OpenclawDriver(adapter, makeStore());
		const session = await driver.openSession({ aiclawUid: '1', roomId: '1', chatContext: {} });
		const stream = session.send('m');
		// Yield a macrotask so chat() has fully run and buffered everything first.
		await new Promise((r) => setImmediate(r));
		const events = await drain(stream);
		expect(events).toEqual([
			{ type: 'thinking', text: 'a' },
			{ type: 'thinking', text: 'b' },
			{ type: 'done', durationMs: 7 },
		]);
	});

	it('close() lets a stuck iterator terminate', async () => {
		// chat never fires a terminal callback; close() must end the stream.
		let savedCb: ThinkingCallbacks | null = null;
		const { adapter } = fakeAdapter((cb) => {
			savedCb = cb;
			cb.onThinkingDelta('hanging');
			// never call onThinkingEnd/onError
			return new Promise<void>(() => {}); // chat stays pending
		});
		const driver = new OpenclawDriver(adapter, makeStore());
		const session = await driver.openSession({ aiclawUid: '1', roomId: '1', chatContext: {} });
		const stream = session.send('m');
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
		expect(savedCb).not.toBeNull();
	});

	it('close() wakes a consumer parked in await (close-during-await)', async () => {
		// chat fires NOTHING and stays pending → the iterator immediately parks on the
		// await with an empty buffer. close() must wake that parked promise so the
		// for-await completes (done) rather than hanging forever.
		const { adapter } = fakeAdapter(() => new Promise<void>(() => {})); // never resolves, no callbacks
		const driver = new OpenclawDriver(adapter, makeStore());
		const session = await driver.openSession({ aiclawUid: '1', roomId: '1', chatContext: {} });
		const stream = session.send('m');

		// Consume with NO events buffered → iterator parks on the await.
		const collected: AgentEvent[] = [];
		const consumed = (async () => {
			for await (const ev of stream) collected.push(ev);
		})();

		// Give the consumer a tick to reach the parked await, then close.
		await new Promise((r) => setImmediate(r));
		await session.close();

		// Timeout guard: a regression (hang) loses the race and fails the test
		// instead of hanging the whole suite.
		const timeout = new Promise<never>((_, reject) => {
			const t = setTimeout(() => reject(new Error('iterator did not terminate after close()')), 1000);
			// don't keep the event loop alive on success
			if (typeof t === 'object' && 'unref' in t) (t as { unref: () => void }).unref();
		});
		await Promise.race([consumed, timeout]);

		// No terminal event was ever pushed → the loop completed with nothing collected.
		expect(collected).toEqual([]);
	});
});

describe('OpenclawDriver.resolveSession (BL-014 #141 — opaque token store lookup)', () => {
	// The OPENCLAW_BIND value is now a node-minted OPAQUE token; resolveBoundSession strips the
	// `openclaw:` prefix upstream, so resolveSession receives the bare token and LOOKS IT UP in the
	// store (no longer a parse — the plaintext binding is never trusted from the agent's env).
	function driverWithStore() {
		const { adapter } = fakeAdapter(() => {});
		const store = makeStore();
		return { driver: new OpenclawDriver(adapter, store), store };
	}

	it('a MINTED token → { aiclawUid, roomId } (exact opaque strings, REQ-029)', async () => {
		const { driver } = driverWithStore();
		// mint happens on openSession; a >2^53 uid/room must survive as an EXACT string.
		await driver.openSession({ aiclawUid: '9007199254740993', roomId: '9007199254740994', chatContext: {} });
		expect(driver.resolveSession!('tok-1')).toEqual({
			aiclawUid: '9007199254740993',
			roomId: '9007199254740994',
		});
	});

	it('a FORGED plaintext binding (never minted) → undefined (anti-forgery: cannot impersonate)', () => {
		const { driver } = driverWithStore();
		// what an agent gets by overwriting OPENCLAW_BIND with a guessed (uid,room) — not a minted token.
		expect(driver.resolveSession!('aiclaw-999-room-888')).toBeUndefined();
		expect(driver.resolveSession!('aiclaw-7-room-42')).toBeUndefined();
	});

	it('a still-`openclaw:`-prefixed input (prefix stripped upstream) → undefined', () => {
		const { driver } = driverWithStore();
		expect(driver.resolveSession!('openclaw:tok-1')).toBeUndefined();
	});

	it('garbage / empty → undefined', () => {
		const { driver } = driverWithStore();
		expect(driver.resolveSession!('garbage')).toBeUndefined();
		expect(driver.resolveSession!('')).toBeUndefined();
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

describe('OpenclawDriver.resetSession (aichatoverview#124)', () => {
	it('returns false (no per-room store — binding IS the session) and does not throw', () => {
		const { adapter } = fakeAdapter(() => {});
		const d = new OpenclawDriver(adapter, makeStore());
		expect(d.resetSession!('7', '42')).toBe(false);
	});
});
