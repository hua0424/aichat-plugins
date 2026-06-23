import { describe, it, expect, vi } from 'vitest';
import { OpencodeDriver } from './opencode-driver.js';
import type { OpencodeServerManager } from './server-manager.js';
import type { SessionStore, StoredSession } from './session-store.js';
import type { OpencodeClient } from '@opencode-ai/sdk';
import type { AgentEvent } from '../events.js';

/** In-memory SessionStore fake. */
function memStore(): SessionStore & { map: Map<string, StoredSession> } {
	const map = new Map<string, StoredSession>();
	return {
		map,
		get: (k) => map.get(k),
		set: (k, v) => {
			map.set(k, v);
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

/** Build a mock OpencodeClient with controllable create/prompt/subscribe. */
function mockClient(opts?: { sessionID?: string }) {
	const ctl = controllableStream();
	const create = vi.fn(async () => ({ data: { id: opts?.sessionID ?? 'ses_new' } }));
	const prompt = vi.fn(async () => ({ data: {} }));
	const subscribe = vi.fn(async () => ({ stream: ctl.stream }));
	const client = {
		session: { create, prompt },
		event: { subscribe },
	} as unknown as OpencodeClient;
	return { client, create, prompt, subscribe, ctl };
}

/** No-op server manager that just hands back the given client. */
function noopServer(client: OpencodeClient): OpencodeServerManager {
	return {
		ensureStarted: vi.fn().mockResolvedValue(undefined),
		stop: vi.fn().mockResolvedValue(undefined),
		getClient: () => client,
	} as unknown as OpencodeServerManager;
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
});
