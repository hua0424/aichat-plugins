import { describe, it, expect, vi } from 'vitest';
import { OpenclawDriver } from './openclaw-driver.js';
import type { ClawAdapter, ThinkingCallbacks, ChatContext } from '../claw/interface.js';
import type { AgentEvent } from './events.js';

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
		const driver = new OpenclawDriver(adapter);
		await driver.connect();
		await driver.disconnect();
		expect((adapter.connect as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
		expect((adapter.disconnect as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
	});

	it('openSession binds the correct sessionKey and roomId', async () => {
		const { adapter, calls } = fakeAdapter((cb) => {
			cb.onThinkingEnd(10);
		});
		const driver = new OpenclawDriver(adapter);
		const session = await driver.openSession({ aiclawUid: 999, roomId: 7, chatContext: {} });
		await drain(session.send('hi'));
		expect(calls[0].sessionKey).toBe('aiclaw-999-room-7');
		expect(calls[0].context).toEqual({ roomId: 7 });
		expect(calls[0].message).toBe('hi');
	});

	it('send: thinking deltas + terminal sent + done → mapped AgentEvent sequence', async () => {
		const { adapter } = fakeAdapter((cb) => {
			cb.onThinkingDelta('foo');
			cb.onThinkingDelta('bar');
			cb.onTerminalTool!({ action: 'sent', tool: 'hula_send_message' });
			cb.onThinkingEnd(123);
		});
		const driver = new OpenclawDriver(adapter);
		const session = await driver.openSession({ aiclawUid: 1, roomId: 1, chatContext: {} });
		const events = await drain(session.send('m'));
		expect(events).toEqual([
			{ type: 'thinking', text: 'foo' },
			{ type: 'thinking', text: 'bar' },
			{ type: 'terminal', action: 'sent', reason: undefined },
			{ type: 'done', durationMs: 123 },
		]);
	});

	it('skip: terminal skipped with reason → mapped + done; iterator ends', async () => {
		const { adapter } = fakeAdapter((cb) => {
			cb.onTerminalTool!({ action: 'skipped', tool: 'hula_skip_reply', reason: 'agent_skip_reply' });
			cb.onThinkingEnd(50);
		});
		const driver = new OpenclawDriver(adapter);
		const session = await driver.openSession({ aiclawUid: 1, roomId: 1, chatContext: {} });
		const events = await drain(session.send('m'));
		expect(events).toEqual([
			{ type: 'terminal', action: 'skipped', reason: 'agent_skip_reply' },
			{ type: 'done', durationMs: 50 },
		]);
	});

	it('error: onError → error event then iterator ends', async () => {
		const { adapter } = fakeAdapter((cb) => {
			cb.onThinkingDelta('partial');
			cb.onError(new Error('boom'));
		});
		const driver = new OpenclawDriver(adapter);
		const session = await driver.openSession({ aiclawUid: 1, roomId: 1, chatContext: {} });
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
			cb.onTerminalTool!({ action: 'sent', tool: 'message' });
			cb.onThinkingEnd(7);
		});
		const driver = new OpenclawDriver(adapter);
		const session = await driver.openSession({ aiclawUid: 1, roomId: 1, chatContext: {} });
		const stream = session.send('m');
		// Yield a macrotask so chat() has fully run and buffered everything first.
		await new Promise((r) => setImmediate(r));
		const events = await drain(stream);
		expect(events).toEqual([
			{ type: 'thinking', text: 'a' },
			{ type: 'thinking', text: 'b' },
			{ type: 'terminal', action: 'sent', reason: undefined },
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
		const driver = new OpenclawDriver(adapter);
		const session = await driver.openSession({ aiclawUid: 1, roomId: 1, chatContext: {} });
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
		const driver = new OpenclawDriver(adapter);
		const session = await driver.openSession({ aiclawUid: 1, roomId: 1, chatContext: {} });
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
