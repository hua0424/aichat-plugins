import { describe, it, expect, vi } from 'vitest';
import { OpencodeDriver } from './opencode-driver.js';
import type { OpencodeServerManager } from './server-manager.js';
import type { SessionStore, StoredSession } from './session-store.js';
import type { OpencodeClient } from '@opencode-ai/sdk';
import type { AgentEvent } from '../events.js';

/** In-memory SessionStore fake. `del` is a spy so tests can assert lazy-rebuild invalidation. */
function memStore(): SessionStore & { map: Map<string, StoredSession>; del: ReturnType<typeof vi.fn> } {
	const map = new Map<string, StoredSession>();
	const del = vi.fn((k: string) => {
		map.delete(k);
	});
	return {
		map,
		del,
		get: (k) => map.get(k),
		set: (k, v) => {
			map.set(k, v);
		},
		delete: del,
		findKeyBySessionID: (sid: string) => {
			for (const [k, v] of map) if (v.sessionID === sid) return k;
			return undefined;
		},
	};
}

/**
 * Controllable async stream: a queue the test pushes events into; the consumer's
 * for-await receives them in order and ends when end() is called.
 */
function controllableStream() {
	const buffer: unknown[] = [];
	let done = false;
	let wake: (() => void) | null = null;
	const ping = () => {
		if (wake) {
			const w = wake;
			wake = null;
			w();
		}
	};
	const stream: AsyncGenerator<unknown> = (async function* () {
		while (true) {
			while (buffer.length > 0) yield buffer.shift()!;
			if (done) return;
			await new Promise<void>((r) => {
				wake = r;
			});
		}
	})();
	return {
		stream,
		emit: (ev: unknown) => {
			buffer.push(ev);
			ping();
		},
		end: () => {
			done = true;
			ping();
		},
	};
}

/**
 * A controllable stream whose async ITERATOR exposes a spied `return()`, so a test can
 * assert the driver closes the underlying SSE subscription (calls iter.return()) on
 * finish()/close(). `return()` also ends the stream so a parked next() resolves done.
 */
function spyableStream() {
	const ctl = controllableStream();
	const returnSpy = vi.fn(async () => {
		ctl.end();
		return { value: undefined, done: true } as IteratorResult<unknown>;
	});
	const inner = ctl.stream[Symbol.asyncIterator]();
	const iterable: AsyncIterable<unknown> = {
		[Symbol.asyncIterator](): AsyncIterator<unknown> {
			return {
				next: () => inner.next(),
				return: returnSpy,
			};
		},
	};
	return { stream: iterable, emit: ctl.emit, end: ctl.end, returnSpy };
}

/** Build a mock OpencodeClient with controllable create/prompt/subscribe. */
function mockClient(opts?: { sessionID?: string; stream?: { stream: AsyncIterable<unknown> } }) {
	const ctl = controllableStream();
	const streamForSubscribe = opts?.stream?.stream ?? ctl.stream;
	const create = vi.fn(async () => ({ data: { id: opts?.sessionID ?? 'ses_new' } }));
	const prompt = vi.fn(async () => ({ data: {} }));
	const subscribe = vi.fn(async () => ({ stream: streamForSubscribe }));
	const client = {
		session: { create, prompt },
		event: { subscribe },
	} as unknown as OpencodeClient;
	return { client, create, prompt, subscribe, ctl };
}

/** No-op server manager that just hands back the given client. `restart` is an observable spy. */
function noopServer(client: OpencodeClient): OpencodeServerManager & { restart: ReturnType<typeof vi.fn> } {
	return {
		ensureStarted: vi.fn().mockResolvedValue(undefined),
		stop: vi.fn().mockResolvedValue(undefined),
		restart: vi.fn().mockResolvedValue(undefined),
		getClient: () => client,
	} as unknown as OpencodeServerManager & { restart: ReturnType<typeof vi.fn> };
}

/**
 * A SHARED (singleton) server manager fake: `started` stays true, `stop` is observable, and
 * `getClient` always returns the same mock client. Mirrors the real "1 server serves N"
 * manager so we can assert one driver's disconnect() never tears it down.
 */
function sharedServer(client: OpencodeClient): OpencodeServerManager & { stop: ReturnType<typeof vi.fn> } {
	let started = true;
	return {
		ensureStarted: vi.fn().mockResolvedValue(undefined),
		stop: vi.fn(async () => {
			started = false;
		}),
		getClient: () => client,
		get started() {
			return started;
		},
	} as unknown as OpencodeServerManager & { stop: ReturnType<typeof vi.fn> };
}

async function drain(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
	const out: AgentEvent[] = [];
	for await (const ev of stream) out.push(ev);
	return out;
}

const BASE = '/tmp/oc-ws';
const SID = 'ses_new';

describe('OpencodeDriver.openSession', () => {
	it('group context → group dir; creates + persists a session', async () => {
		const { client, create } = mockClient();
		const store = memStore();
		const driver = new OpencodeDriver({ server: noopServer(client), workspaceBase: BASE, sessionStore: store });

		await driver.openSession({ aiclawUid: 5, roomId: 9, chatContext: { roomType: 1, roomId: 9 } });

		expect(create).toHaveBeenCalledOnce();
		const arg = create.mock.calls[0][0] as { query: { directory: string }; body: { title: string } };
		expect(arg.query.directory).toContain('/group/9');
		const stored = store.map.get('aiclaw-5-room-9');
		expect(stored?.sessionID).toBe(SID);
		expect(stored?.directory).toContain('/group/9');
	});

	it('dm context → dm/<counterpartUid> dir', async () => {
		const { client, create } = mockClient();
		const driver = new OpencodeDriver({ server: noopServer(client), workspaceBase: BASE, sessionStore: memStore() });
		await driver.openSession({ aiclawUid: 5, roomId: 9, chatContext: { roomType: 2, roomId: 9, counterpartUid: 1234 } });
		const arg = create.mock.calls[0][0] as { query: { directory: string } };
		expect(arg.query.directory).toContain('/dm/1234');
	});

	it('REUSES a persisted session for the same key+directory (no 2nd create)', async () => {
		const { client, create } = mockClient();
		const store = memStore();
		const driver = new OpencodeDriver({ server: noopServer(client), workspaceBase: BASE, sessionStore: store });

		await driver.openSession({ aiclawUid: 5, roomId: 9, chatContext: { roomType: 1, roomId: 9 } });
		await driver.openSession({ aiclawUid: 5, roomId: 9, chatContext: { roomType: 1, roomId: 9 } });

		expect(create).toHaveBeenCalledOnce(); // second openSession reused, did NOT create again
	});
});

describe('OpencodeDriver.resolveSession (REQ-010 S1)', () => {
	it('after openSession, resolveSession(sessionID) → {aiclawUid, roomId}', async () => {
		const { client } = mockClient({ sessionID: 'ses_xyz' });
		const store = memStore();
		const driver = new OpencodeDriver({ server: noopServer(client), workspaceBase: BASE, sessionStore: store });
		await driver.openSession({ aiclawUid: 5, roomId: 9, chatContext: { roomType: 1, roomId: 9 } });

		expect(driver.resolveSession('ses_xyz')).toEqual({ aiclawUid: 5, roomId: 9 });
	});

	it('unknown sessionID → undefined', async () => {
		const { client } = mockClient({ sessionID: 'ses_xyz' });
		const driver = new OpencodeDriver({ server: noopServer(client), workspaceBase: BASE, sessionStore: memStore() });
		await driver.openSession({ aiclawUid: 5, roomId: 9, chatContext: { roomType: 1, roomId: 9 } });

		expect(driver.resolveSession('ses_nope')).toBeUndefined();
	});
});

describe('OpencodeDriver.disconnect isolation (shared singleton server)', () => {
	it('disconnect() is a no-op: does NOT stop the shared server; other identities keep working', async () => {
		const { client, create } = mockClient();
		const server = sharedServer(client);
		const store1 = memStore();
		const store2 = memStore();
		const driver1 = new OpencodeDriver({ server, workspaceBase: BASE, sessionStore: store1 });
		const driver2 = new OpencodeDriver({ server, workspaceBase: BASE, sessionStore: store2 });

		// One identity is degraded/disconnected.
		await driver1.disconnect();

		// The shared server is untouched: stop NOT called, still started.
		expect(server.stop).not.toHaveBeenCalled();
		expect(server.started).toBe(true);

		// The OTHER identity still opens sessions against the shared client.
		const session = await driver2.openSession({ aiclawUid: 7, roomId: 3, chatContext: { roomType: 1, roomId: 3 } });
		expect(session).toBeDefined();
		expect(create).toHaveBeenCalledOnce();
		expect(store2.map.get('aiclaw-7-room-3')?.sessionID).toBe(SID);
	});
});

describe('OpencodeSession.send', () => {
	it('yields mapped thinking deltas + deduped tool start/end + done(durationMs:number)', async () => {
		const { client, ctl, subscribe, prompt } = mockClient();
		const driver = new OpencodeDriver({ server: noopServer(client), workspaceBase: BASE, sessionStore: memStore() });
		const session = await driver.openSession({ aiclawUid: 1, roomId: 1, chatContext: { roomType: 1, roomId: 1 } });

		const stream = session.send('do it');
		// let subscribe()/prompt() run before emitting
		await new Promise((r) => setImmediate(r));
		expect(subscribe).toHaveBeenCalledOnce();
		expect(prompt).toHaveBeenCalledOnce();

		// emit a turn: two text deltas, a tool that goes running→running(dup)→completed, then idle
		ctl.emit({ type: 'message.part.updated', properties: { part: { type: 'text', sessionID: SID, text: 'A' }, delta: 'A' } });
		ctl.emit({ type: 'message.part.updated', properties: { part: { type: 'text', sessionID: SID, text: 'B' }, delta: 'B' } });
		ctl.emit({ type: 'message.part.updated', properties: { part: { type: 'tool', sessionID: SID, tool: 'bash', callID: 'c1', state: { status: 'running' } } } });
		ctl.emit({ type: 'message.part.updated', properties: { part: { type: 'tool', sessionID: SID, tool: 'bash', callID: 'c1', state: { status: 'running' } } } }); // dup start
		ctl.emit({ type: 'message.part.updated', properties: { part: { type: 'tool', sessionID: SID, tool: 'bash', callID: 'c1', state: { status: 'completed' } } } });
		ctl.emit({ type: 'session.idle', properties: { sessionID: SID } });

		const events = await drain(stream);
		expect(events.slice(0, 4)).toEqual([
			{ type: 'thinking', text: 'A' },
			{ type: 'thinking', text: 'B' },
			{ type: 'tool', name: 'bash', phase: 'start' },
			{ type: 'tool', name: 'bash', phase: 'end' },
		]);
		const last = events[events.length - 1];
		expect(last.type).toBe('done');
		expect(typeof (last as { durationMs: number }).durationMs).toBe('number');
		// exactly one start + one end despite the duplicate running event
		expect(events.filter((e) => e.type === 'tool')).toHaveLength(2);
	});

	it('ignores events for a different session', async () => {
		const { client, ctl } = mockClient();
		const driver = new OpencodeDriver({ server: noopServer(client), workspaceBase: BASE, sessionStore: memStore() });
		const session = await driver.openSession({ aiclawUid: 1, roomId: 1, chatContext: { roomType: 1, roomId: 1 } });
		const stream = session.send('m');
		await new Promise((r) => setImmediate(r));
		ctl.emit({ type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'OTHER', text: 'x' }, delta: 'x' } });
		ctl.emit({ type: 'message.part.updated', properties: { part: { type: 'text', sessionID: SID, text: 'mine' }, delta: 'mine' } });
		ctl.emit({ type: 'session.idle', properties: { sessionID: SID } });
		const events = await drain(stream);
		const thinking = events.filter((e) => e.type === 'thinking');
		expect(thinking).toEqual([{ type: 'thinking', text: 'mine' }]);
	});

	it('session.error → error event then ends', async () => {
		const { client, ctl } = mockClient();
		const driver = new OpencodeDriver({ server: noopServer(client), workspaceBase: BASE, sessionStore: memStore() });
		const session = await driver.openSession({ aiclawUid: 1, roomId: 1, chatContext: { roomType: 1, roomId: 1 } });
		const stream = session.send('m');
		await new Promise((r) => setImmediate(r));
		ctl.emit({ type: 'message.part.updated', properties: { part: { type: 'text', sessionID: SID, text: 'partial' }, delta: 'partial' } });
		ctl.emit({ type: 'session.error', properties: { sessionID: SID, error: { name: 'UnknownError', data: { message: 'kaboom' } } } });
		const events = await drain(stream);
		expect(events).toEqual([
			{ type: 'thinking', text: 'partial' },
			{ type: 'error', message: 'UnknownError: kaboom' },
		]);
	});

	it('prompt rejection surfaces as a terminal error', async () => {
		const { client, prompt } = mockClient();
		(prompt as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('prompt failed'));
		const driver = new OpencodeDriver({ server: noopServer(client), workspaceBase: BASE, sessionStore: memStore() });
		const session = await driver.openSession({ aiclawUid: 1, roomId: 1, chatContext: { roomType: 1, roomId: 1 } });
		const events = await drain(session.send('m'));
		expect(events).toEqual([{ type: 'error', message: 'prompt failed' }]);
	});

	it('prompt rejection AND session.error → exactly ONE error event, then ends (dedup)', async () => {
		const { client, ctl, prompt } = mockClient();
		(prompt as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('prompt failed'));
		const driver = new OpencodeDriver({ server: noopServer(client), workspaceBase: BASE, sessionStore: memStore() });
		const session = await driver.openSession({ aiclawUid: 1, roomId: 1, chatContext: { roomType: 1, roomId: 1 } });
		const stream = session.send('m');
		await new Promise((r) => setImmediate(r));
		// Both error sources fire for the SAME session: the SSE error AND the rejected prompt.
		ctl.emit({ type: 'session.error', properties: { sessionID: SID, error: { name: 'UnknownError', data: { message: 'kaboom' } } } });
		const events = await drain(stream);
		const errors = events.filter((e) => e.type === 'error');
		expect(errors).toHaveLength(1); // exactly one error survives the dedup guard
		// the stream ended (last event is the single error; no events buffered after it)
		expect(events[events.length - 1].type).toBe('error');
	});

	it('close() terminates a parked consumer (no terminal event ever arrives)', async () => {
		const { client } = mockClient();
		const driver = new OpencodeDriver({ server: noopServer(client), workspaceBase: BASE, sessionStore: memStore() });
		const session = await driver.openSession({ aiclawUid: 1, roomId: 1, chatContext: { roomType: 1, roomId: 1 } });
		const stream = session.send('m');
		const collected: AgentEvent[] = [];
		const consumed = (async () => {
			for await (const ev of stream) collected.push(ev);
		})();
		await new Promise((r) => setImmediate(r));
		await session.close();
		const timeout = new Promise<never>((_, reject) => {
			const t = setTimeout(() => reject(new Error('iterator did not terminate after close()')), 1000);
			if (typeof t === 'object' && 'unref' in t) (t as { unref: () => void }).unref();
		});
		await Promise.race([consumed, timeout]);
		expect(collected).toEqual([]);
	});

	it('close() mid-park calls the SSE iterator return() (closes the subscription, no leak)', async () => {
		const spied = spyableStream();
		const { client } = mockClient({ stream: { stream: spied.stream } });
		const driver = new OpencodeDriver({ server: noopServer(client), workspaceBase: BASE, sessionStore: memStore() });
		const session = await driver.openSession({ aiclawUid: 1, roomId: 1, chatContext: { roomType: 1, roomId: 1 } });
		const stream = session.send('m');
		const consumed = (async () => {
			for await (const _ev of stream) void _ev;
		})();
		// Let subscribe()/prompt() run and the SSE loop PARK on iter.next() (no event emitted).
		await new Promise((r) => setImmediate(r));
		await session.close();
		const timeout = new Promise<never>((_, reject) => {
			const t = setTimeout(() => reject(new Error('iterator did not terminate after close()')), 1000);
			if (typeof t === 'object' && 'unref' in t) (t as { unref: () => void }).unref();
		});
		await Promise.race([consumed, timeout]);
		// The parked SSE subscription was actively closed, not just abandoned.
		expect(spied.returnSpy).toHaveBeenCalled();
	});

	// REQ-010 S1 — the role-instruction prefix now points at the `aichat send-message` capability,
	// NOT the retired hula_send_message tool.
	it('role prompt prefix instructs `aichat send-message`, NOT hula_send_message (user message preserved)', async () => {
		const { client, prompt } = mockClient();
		const driver = new OpencodeDriver({ server: noopServer(client), workspaceBase: BASE, sessionStore: memStore() });
		const session = await driver.openSession({ aiclawUid: 1, roomId: 1, chatContext: { roomType: 1, roomId: 1 } });
		session.send('原始用户消息');
		await new Promise((r) => setImmediate(r));
		expect(prompt).toHaveBeenCalledOnce();
		const body = (prompt.mock.calls[0][0] as { body: { parts: Array<{ text: string }> } }).body;
		const text = body.parts[0].text;
		expect(text).toContain('aichat send-message');
		expect(text).not.toContain('hula_send_message');
		expect(text).not.toContain('hula_skip_reply');
		expect(text.endsWith('原始用户消息')).toBe(true);
		// no [SYSTEM] markers (gateway security hardening)
		expect(text).not.toContain('[SYSTEM]');
	});

	// REQ-008 #78 P2③ — onSessionError invalidates the store entry on a send error.
	it('prompt rejection invalidates the stored session (store.delete + server.restart) for lazy rebuild', async () => {
		const { client, prompt } = mockClient();
		(prompt as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('session gone'));
		const server = noopServer(client);
		const store = memStore();
		const driver = new OpencodeDriver({ server, workspaceBase: BASE, sessionStore: store });
		const session = await driver.openSession({ aiclawUid: 4, roomId: 8, chatContext: { roomType: 1, roomId: 8 } });
		expect(store.map.has('aiclaw-4-room-8')).toBe(true);
		const events = await drain(session.send('m'));
		expect(events).toEqual([{ type: 'error', message: 'session gone' }]);
		// the stale binding is dropped so the NEXT openSession recreates it lazily
		expect(store.del).toHaveBeenCalledWith('aiclaw-4-room-8');
		expect(store.map.has('aiclaw-4-room-8')).toBe(false);
		expect(server.restart).toHaveBeenCalled();
	});

	it('subscribe rejection invalidates the stored session (store.delete) for lazy rebuild', async () => {
		const { client, subscribe } = mockClient();
		(subscribe as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('server down'));
		const server = noopServer(client);
		const store = memStore();
		const driver = new OpencodeDriver({ server, workspaceBase: BASE, sessionStore: store });
		const session = await driver.openSession({ aiclawUid: 4, roomId: 8, chatContext: { roomType: 1, roomId: 8 } });
		const events = await drain(session.send('m'));
		expect(events).toEqual([{ type: 'error', message: 'server down' }]);
		expect(store.del).toHaveBeenCalledWith('aiclaw-4-room-8');
		expect(server.restart).toHaveBeenCalled();
	});
});
