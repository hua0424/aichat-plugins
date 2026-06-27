import { describe, it, expect, vi } from 'vitest';
import { CodexDriver, type CodexClient } from './codex-driver.js';
import type { CodexSessionStore, StoredCodexSession } from './session-store.js';
import type { Thread, ThreadOptions } from '@openai/codex-sdk';
import type { AgentEvent } from '../events.js';

/** In-memory CodexSessionStore fake. `del` is a spy so a test could assert invalidation. */
function memStore(): CodexSessionStore & { map: Map<string, StoredCodexSession>; del: ReturnType<typeof vi.fn> } {
	const map = new Map<string, StoredCodexSession>();
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
		findKeyByThreadId: (tid: string) => {
			for (const [k, v] of map) if (v.threadId === tid) return k;
			return undefined;
		},
	};
}

/**
 * Controllable async stream: a queue the test pushes ThreadEvents into; the consumer's for-await
 * receives them in order and ends when end() is called. Mirrors opencode-driver.test's helper.
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
 * A controllable stream whose async ITERATOR exposes a spied `return()`, so a test can assert the
 * driver terminates the events generator on close(). `return()` also ends the stream.
 */
function spyableStream() {
	const ctl = controllableStream();
	const returnSpy = vi.fn(async () => {
		ctl.end();
		return { value: undefined, done: true } as IteratorResult<unknown>;
	});
	const inner = ctl.stream[Symbol.asyncIterator]();
	const events: AsyncGenerator<unknown> = {
		next: () => inner.next(),
		return: returnSpy,
		throw: (e?: unknown) => inner.throw?.(e) ?? Promise.resolve({ value: undefined, done: true }),
		[Symbol.asyncIterator]() {
			return this;
		},
	} as unknown as AsyncGenerator<unknown>;
	return { events, emit: ctl.emit, end: ctl.end, returnSpy };
}

/**
 * Build a fake Codex client. `runStreamed` returns the supplied events stream (or a fresh
 * controllable one). startThread/resumeThread are spies so tests assert which path + opts.
 */
function mockCodex(opts?: { stream?: AsyncGenerator<unknown>; rejectRun?: Error }) {
	const ctl = controllableStream();
	const events = opts?.stream ?? ctl.stream;
	const runStreamed = vi.fn(async () => {
		if (opts?.rejectRun) throw opts.rejectRun;
		return { events };
	});
	const thread = { runStreamed, get id() { return null; } } as unknown as Thread;
	const startThread = vi.fn((_o?: ThreadOptions) => thread);
	const resumeThread = vi.fn((_id: string, _o?: ThreadOptions) => thread);
	const codex: CodexClient = { startThread, resumeThread };
	return { codex, startThread, resumeThread, thread, runStreamed, ctl };
}

async function drain(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
	const out: AgentEvent[] = [];
	for await (const ev of stream) out.push(ev);
	return out;
}

const BASE = '/tmp/codex-ws';
const TID = 'thread_abc';

describe('CodexDriver.openSession', () => {
	it('group context → group dir; NEW key → startThread with full threadOpts', async () => {
		const { codex, startThread, resumeThread } = mockCodex();
		const driver = new CodexDriver({ codex, workspaceBase: BASE, sessionStore: memStore() });

		await driver.openSession({ aiclawUid: 5, roomId: 9, chatContext: { roomType: 1, roomId: 9 } });

		expect(startThread).toHaveBeenCalledOnce();
		expect(resumeThread).not.toHaveBeenCalled();
		const opts = startThread.mock.calls[0][0] as ThreadOptions;
		expect(opts.sandboxMode).toBe('danger-full-access');
		expect(opts.approvalPolicy).toBe('never');
		expect(opts.skipGitRepoCheck).toBe(true);
		expect(opts.workingDirectory).toContain('/group/9');
		// no model override → no model key
		expect('model' in opts).toBe(false);
	});

	it('dm context → dm/<counterpartUid> workingDirectory', async () => {
		const { codex, startThread } = mockCodex();
		const driver = new CodexDriver({ codex, workspaceBase: BASE, sessionStore: memStore() });
		await driver.openSession({ aiclawUid: 5, roomId: 9, chatContext: { roomType: 2, roomId: 9, counterpartUid: 1234 } });
		const opts = startThread.mock.calls[0][0] as ThreadOptions;
		expect(opts.workingDirectory).toContain('/dm/1234');
	});

	it('RESUMES when the store already has a threadId for the key', async () => {
		const { codex, startThread, resumeThread } = mockCodex();
		const store = memStore();
		store.set('aiclaw-5-room-9', { threadId: 'thread_prev' });
		const driver = new CodexDriver({ codex, workspaceBase: BASE, sessionStore: store });

		await driver.openSession({ aiclawUid: 5, roomId: 9, chatContext: { roomType: 1, roomId: 9 } });

		expect(resumeThread).toHaveBeenCalledOnce();
		expect(resumeThread.mock.calls[0][0]).toBe('thread_prev');
		expect(startThread).not.toHaveBeenCalled();
	});

	it('model override flows into threadOpts.model', async () => {
		const { codex, startThread } = mockCodex();
		const driver = new CodexDriver({ codex, workspaceBase: BASE, sessionStore: memStore(), model: 'gpt-5-codex' });
		await driver.openSession({ aiclawUid: 1, roomId: 1, chatContext: { roomType: 1, roomId: 1 } });
		const opts = startThread.mock.calls[0][0] as ThreadOptions;
		expect(opts.model).toBe('gpt-5-codex');
	});
});

describe('CodexDriver.resolveSession', () => {
	it('after a turn captures thread.started, resolveSession(threadId) → {aiclawUid, roomId}', async () => {
		const { codex, ctl } = mockCodex();
		const store = memStore();
		const driver = new CodexDriver({ codex, workspaceBase: BASE, sessionStore: store });
		const session = await driver.openSession({ aiclawUid: 5, roomId: 9, chatContext: { roomType: 1, roomId: 9 } });

		const stream = session.send('hi');
		await new Promise((r) => setImmediate(r));
		ctl.emit({ type: 'thread.started', thread_id: TID });
		ctl.emit({ type: 'turn.completed', usage: {} });
		await drain(stream);

		// stored BOTH directions
		expect(store.map.get('aiclaw-5-room-9')?.threadId).toBe(TID);
		expect(driver.resolveSession(TID)).toEqual({ aiclawUid: 5, roomId: 9 });
	});

	it('unknown threadId → undefined', () => {
		const { codex } = mockCodex();
		const driver = new CodexDriver({ codex, workspaceBase: BASE, sessionStore: memStore() });
		expect(driver.resolveSession('thread_nope')).toBeUndefined();
	});
});

describe('CodexSession.send', () => {
	it('thread.started captured+stored NOT yielded; reasoning/agent_message→thinking; command_execution→tool start/end deduped; turn.completed→done', async () => {
		const { codex, ctl, runStreamed } = mockCodex();
		const store = memStore();
		const driver = new CodexDriver({ codex, workspaceBase: BASE, sessionStore: store });
		const session = await driver.openSession({ aiclawUid: 1, roomId: 1, chatContext: { roomType: 1, roomId: 1 } });

		const stream = session.send('do it');
		await new Promise((r) => setImmediate(r));
		expect(runStreamed).toHaveBeenCalledOnce();

		ctl.emit({ type: 'thread.started', thread_id: TID });
		ctl.emit({ type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: 'thinking...' } });
		ctl.emit({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'analysis' } });
		ctl.emit({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'bash -c ls', aggregated_output: '', status: 'in_progress' } });
		ctl.emit({ type: 'item.updated', item: { id: 'c1', type: 'command_execution', command: 'bash -c ls', aggregated_output: 'x', status: 'in_progress' } }); // dup start
		ctl.emit({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'bash -c ls', aggregated_output: 'x', exit_code: 0, status: 'completed' } });
		ctl.emit({ type: 'turn.completed', usage: { input_tokens: 1 } });

		const events = await drain(stream);
		expect(events.slice(0, 4)).toEqual([
			{ type: 'thinking', text: 'thinking...' },
			{ type: 'thinking', text: 'analysis' },
			{ type: 'tool', name: 'bash', phase: 'start' },
			{ type: 'tool', name: 'bash', phase: 'end' },
		]);
		const last = events[events.length - 1];
		expect(last.type).toBe('done');
		expect(typeof (last as { durationMs: number }).durationMs).toBe('number');
		// exactly one start + one end despite the duplicate in_progress event
		expect(events.filter((e) => e.type === 'tool')).toHaveLength(2);
		// thread.started never yielded as an AgentEvent
		expect(events.some((e) => (e as { type: string }).type === 'thread.started')).toBe(false);
		// stored under the key
		expect(store.map.get('aiclaw-1-room-1')?.threadId).toBe(TID);
	});

	it('turn.failed → error event then ends', async () => {
		const { codex, ctl } = mockCodex();
		const driver = new CodexDriver({ codex, workspaceBase: BASE, sessionStore: memStore() });
		const session = await driver.openSession({ aiclawUid: 1, roomId: 1, chatContext: { roomType: 1, roomId: 1 } });
		const stream = session.send('m');
		await new Promise((r) => setImmediate(r));
		ctl.emit({ type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: 'partial' } });
		ctl.emit({ type: 'turn.failed', error: { message: 'kaboom' } });
		// anything after the terminal error must be dropped:
		ctl.emit({ type: 'turn.completed', usage: {} });
		const events = await drain(stream);
		expect(events).toEqual([
			{ type: 'thinking', text: 'partial' },
			{ type: 'error', message: 'kaboom' },
		]);
	});

	it('fatal stream error event → error then ends', async () => {
		const { codex, ctl } = mockCodex();
		const driver = new CodexDriver({ codex, workspaceBase: BASE, sessionStore: memStore() });
		const session = await driver.openSession({ aiclawUid: 1, roomId: 1, chatContext: { roomType: 1, roomId: 1 } });
		const stream = session.send('m');
		await new Promise((r) => setImmediate(r));
		ctl.emit({ type: 'error', message: 'unrecoverable' });
		const events = await drain(stream);
		expect(events).toEqual([{ type: 'error', message: 'unrecoverable' }]);
	});

	it('runStreamed rejection surfaces as a terminal error', async () => {
		const { codex } = mockCodex({ rejectRun: new Error('codex exec failed') });
		const driver = new CodexDriver({ codex, workspaceBase: BASE, sessionStore: memStore() });
		const session = await driver.openSession({ aiclawUid: 1, roomId: 1, chatContext: { roomType: 1, roomId: 1 } });
		const events = await drain(session.send('m'));
		expect(events).toEqual([{ type: 'error', message: 'codex exec failed' }]);
	});

	it('role prompt prefix instructs `aichat send-message`, NOT hula_send_message; user message preserved; no [SYSTEM]', async () => {
		const { codex, runStreamed } = mockCodex();
		const driver = new CodexDriver({ codex, workspaceBase: BASE, sessionStore: memStore() });
		const session = await driver.openSession({ aiclawUid: 1, roomId: 1, chatContext: { roomType: 1, roomId: 1 } });
		session.send('原始用户消息');
		await new Promise((r) => setImmediate(r));
		expect(runStreamed).toHaveBeenCalledOnce();
		const input = runStreamed.mock.calls[0][0] as unknown as string;
		expect(input).toContain('aichat send-message');
		expect(input).not.toContain('hula_send_message');
		expect(input.endsWith('原始用户消息')).toBe(true);
		expect(input).not.toContain('[SYSTEM]');
	});

	it('close() terminates a parked consumer (no terminal event ever arrives)', async () => {
		const { codex } = mockCodex();
		const driver = new CodexDriver({ codex, workspaceBase: BASE, sessionStore: memStore() });
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

	it('close() mid-park calls the events generator return() (no leak)', async () => {
		const spied = spyableStream();
		const { codex } = mockCodex({ stream: spied.events });
		const driver = new CodexDriver({ codex, workspaceBase: BASE, sessionStore: memStore() });
		const session = await driver.openSession({ aiclawUid: 1, roomId: 1, chatContext: { roomType: 1, roomId: 1 } });
		const stream = session.send('m');
		const consumed = (async () => {
			for await (const _ev of stream) void _ev;
		})();
		await new Promise((r) => setImmediate(r));
		await session.close();
		const timeout = new Promise<never>((_, reject) => {
			const t = setTimeout(() => reject(new Error('iterator did not terminate after close()')), 1000);
			if (typeof t === 'object' && 'unref' in t) (t as { unref: () => void }).unref();
		});
		await Promise.race([consumed, timeout]);
		expect(spied.returnSpy).toHaveBeenCalled();
	});
});

describe('CodexDriver.connect/disconnect', () => {
	it('connect() and disconnect() are no-ops (no shared server)', async () => {
		const { codex } = mockCodex();
		const driver = new CodexDriver({ codex, workspaceBase: BASE, sessionStore: memStore() });
		await expect(driver.connect()).resolves.toBeUndefined();
		await expect(driver.disconnect()).resolves.toBeUndefined();
	});
});
