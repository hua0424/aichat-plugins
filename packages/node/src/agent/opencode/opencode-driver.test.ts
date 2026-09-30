import { describe, expect, it, vi } from 'vitest';
import type { OpencodeClient } from '@opencode-ai/sdk';
import type { AgentEvent, PreparedRun } from '../events.js';
import type { OpencodeServerManager } from './server-manager.js';
import { OpencodeDriver } from './opencode-driver.js';

function fixture(native?: unknown) {
	const events: unknown[] = [];
	let notify: (() => void) | undefined;
	let closed = false;
	const emit = (event: unknown) => { events.push(event); notify?.(); };
	const stream = {
		async *[Symbol.asyncIterator]() {
			yield { type: 'server.connected', properties: {} };
			while (!closed) {
				if (events.length) yield events.shift();
				else await new Promise<void>((resolve) => { notify = resolve; });
			}
		},
	};
	const create = vi.fn(async () => ({ data: { id: 's1' } }));
	let resolvePrompt!: (result: { data: { info: { id: string; sessionID: string; error?: unknown } } }) => void;
	const prompt = vi.fn(() => new Promise<{ data: { info: { id: string; sessionID: string; error?: unknown } } }>((resolve) => { resolvePrompt = resolve; }));
	const complete = (error?: unknown) => resolvePrompt({ data: { info: { id: 'assistant-message', sessionID: 's1', ...(error ? { error } : {}) } } });
	const abort = vi.fn(async () => ({ data: true }));
	const status = vi.fn(async () => ({ data: { s1: { type: 'idle' } } }));
	const subscribe = vi.fn(async () => ({ stream }));
	const client = { session: { create, prompt, abort, status }, event: { subscribe } } as unknown as OpencodeClient;
	const server = { ensureStarted: vi.fn(async () => {}), getClient: () => client, stop: vi.fn(), restart: vi.fn() } as unknown as OpencodeServerManager;
	let state = native;
	const saveRecovery = vi.fn(async () => {});
	const registerNative = vi.fn(async (_id: string, value: { value: unknown }) => { state = value.value; });
	const input = { runId: 'r1', message: 'hello', workspace: '/tmp/oc-native-test', systemPrompt: 'persona 1', signal: new AbortController().signal,
		conversation: { id: 'conversation-1', generation: 1, get nativeState() { return state === undefined ? undefined : { version: 1, value: state }; },
			assertCurrent: vi.fn(), saveNativeState: vi.fn(), registerNativeAlias: vi.fn(), registerNative },
		saveRecovery, capabilities: { invoke: vi.fn() }, contextKey: 'context' } as PreparedRun;
	const driver = new OpencodeDriver({ server, model: 'vendor/model', cancelTimeoutMs: 50 });
	const cleanup = () => { closed = true; notify?.(); };
	return { driver, input, create, prompt, complete, abort, status, subscribe, server, saveRecovery, registerNative,
		emit, cleanup, get state() { return state; } };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
	const result: AgentEvent[] = [];
	for await (const event of events) result.push(event);
	return result;
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('native OpenCode AgentRun', () => {
	it('createRun is synchronous and performs no I/O until events consumption', async () => {
		const f = fixture();
		const run = f.driver.createRun(f.input);
		expect(f.create).not.toHaveBeenCalled();
		expect(f.subscribe).not.toHaveBeenCalled();
		const pending = collect(run.events);
		await vi.waitFor(() => expect(f.prompt).toHaveBeenCalled());
		await tick();
		f.emit({ type: 'session.idle', properties: { sessionID: 's1' } });
		f.complete();
		expect(await pending).toEqual([expect.objectContaining({ type: 'done' })]);
		expect(f.state).toEqual({ sessionID: 's1', directory: f.input.workspace });
		expect(f.registerNative).toHaveBeenCalledWith('s1', { version: 1, value: f.state });
		expect(f.saveRecovery).toHaveBeenCalledWith({ version: 1, value: expect.objectContaining({ sessionID: 's1' }) });
		expect(f.prompt).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ system: 'persona 1', model: { providerID: 'vendor', modelID: 'model' }, parts: [{ type: 'text', text: 'hello' }] }) }));
		f.cleanup();
	});

	it('resumes same directory/session without creating; per-run prompt remains independent', async () => {
		const f = fixture({ sessionID: 's1', directory: '/tmp/oc-native-test' });
		const pending = collect(f.driver.createRun({ ...f.input, systemPrompt: 'persona 2' }).events);
		await vi.waitFor(() => expect(f.prompt).toHaveBeenCalled());
		await tick();
		f.emit({ type: 'session.idle', properties: { sessionID: 's1' } });
		f.complete();
		expect((await pending).at(-1)?.type).toBe('done');
		expect(f.create).not.toHaveBeenCalled();
		expect(f.registerNative).not.toHaveBeenCalled();
		expect(f.prompt).toHaveBeenCalledWith(expect.objectContaining({ body: expect.objectContaining({ system: 'persona 2' }) }));
		f.cleanup();
	});

	it('rejects changed directory without discarding old native history', async () => {
		const previous = { sessionID: 's1', directory: '/somewhere-else' };
		const f = fixture(previous);
		expect(await collect(f.driver.createRun(f.input).events)).toEqual([{ type: 'error', message: expect.stringContaining('explicit reset') }]);
		expect(f.state).toBe(previous);
		expect(f.create).not.toHaveBeenCalled();
	});

	it('generation rotated during native create never submits a prompt', async () => {
		const f = fixture();
		f.registerNative.mockImplementation(async () => { throw Error('stale generation'); });
		expect(await collect(f.driver.createRun(f.input).events)).toEqual([{ type: 'error', message: 'stale generation' }]);
		expect(f.prompt).not.toHaveBeenCalled();
		f.cleanup();
	});

	it('unscoped/shared session error does not affect another identity; assistant parts only', async () => {
		const f = fixture();
		const pending = collect(f.driver.createRun(f.input).events);
		await vi.waitFor(() => expect(f.prompt).toHaveBeenCalled());
		f.emit({ type: 'session.error', properties: { error: 'other identity failed' } });
		f.emit({ type: 'message.updated', properties: { info: { id: 'U', sessionID: 's1', role: 'user' } } });
		f.emit({ type: 'message.part.updated', properties: { part: { type: 'text', messageID: 'U', sessionID: 's1' }, delta: 'secret user text' } });
		f.emit({ type: 'message.updated', properties: { info: { id: 'A', sessionID: 's1', role: 'assistant' } } });
		f.emit({ type: 'message.part.updated', properties: { part: { type: 'text', messageID: 'A', sessionID: 's1' }, delta: 'thinking' } });
		f.emit({ type: 'session.idle', properties: { sessionID: 's1' } });
		await tick();
		f.complete();
		expect(await pending).toEqual([{ type: 'thinking', text: 'thinking' }, expect.objectContaining({ type: 'done' })]);
		f.cleanup();
	});

	it('stale session.idle after prompt submission cannot complete this turn', async () => {
		const f = fixture({ sessionID: 's1', directory: '/tmp/oc-native-test' });
		const run = f.driver.createRun(f.input);
		let finished = false;
		const pending = collect(run.events).then((events) => { finished = true; return events; });
		await vi.waitFor(() => expect(f.prompt).toHaveBeenCalled());
		f.emit({ type: 'session.idle', properties: { sessionID: 's1' } });
		await tick();
		expect(finished).toBe(false);
		f.complete(); // only correlated HTTP completion can terminate
		expect((await pending).at(-1)?.type).toBe('done');
		f.cleanup();
	});

	it('prompt rejection and assistant response error never report done', async () => {
		const f = fixture();
		f.prompt.mockRejectedValueOnce(new Error('prompt failed'));
		expect(await collect(f.driver.createRun(f.input).events)).toEqual([{ type: 'error', message: 'prompt failed' }]);
		const g = fixture();
		const pending = collect(g.driver.createRun(g.input).events);
		await vi.waitFor(() => expect(g.prompt).toHaveBeenCalled());
		g.complete({ name: 'UnknownError', data: { message: 'backend failed' } });
		expect(await pending).toEqual([{ type: 'error', message: expect.stringContaining('backend failed') }]);
		f.cleanup(); g.cleanup();
	});

	it('duplicate tool phases are deduplicated by callID', async () => {
		const f = fixture();
		const pending = collect(f.driver.createRun(f.input).events);
		await vi.waitFor(() => expect(f.prompt).toHaveBeenCalled());
		for (const status of ['running', 'running', 'completed', 'completed']) {
			f.emit({ type: 'message.part.updated', properties: { part: { type: 'tool', sessionID: 's1', callID: 'c1', tool: 'bash', state: { status } } } });
		}
		await tick();
		f.complete();
		expect(await pending).toEqual([
			{ type: 'tool', name: 'bash', phase: 'start' }, { type: 'tool', name: 'bash', phase: 'end' }, expect.objectContaining({ type: 'done' }),
		]);
		f.cleanup();
	});

	it('permission ask fails immediately even when correlated HTTP prompt stays unresolved', async () => {
		const f = fixture();
		const pending = collect(f.driver.createRun(f.input).events);
		await vi.waitFor(() => expect(f.prompt).toHaveBeenCalled());
		f.emit({ type: 'permission.asked', properties: { sessionID: 's1', permission: 'external_directory', patterns: ['/private'] } });
		expect(await pending).toEqual([{ type: 'error', message: expect.stringContaining('external_directory') }]);
		f.complete(); // late HTTP response cannot append a duplicate terminal
		await tick();
		expect(f.state).toEqual({ sessionID: 's1', directory: f.input.workspace });
		f.cleanup();
	});

	it('SSE EOF is not success, nor a request to restart shared backend or delete history', async () => {
		const f = fixture();
		const pending = collect(f.driver.createRun(f.input).events);
		await vi.waitFor(() => expect(f.prompt).toHaveBeenCalled());
		f.cleanup();
		// The HTTP prompt deliberately never resolves; SSE EOF must wake immediately.
		expect(await pending).toEqual([{ type: 'error', message: expect.stringContaining('UNEXPECTED_EOF') }]);
		expect(f.server.restart).not.toHaveBeenCalled();
		expect(f.server.stop).not.toHaveBeenCalled();
		expect(f.state).toEqual({ sessionID: 's1', directory: f.input.workspace });
	});

	it('abort false is unconfirmed; cancellation does not release another identity backend', async () => {
		const f = fixture();
		f.abort.mockResolvedValueOnce({ data: false });
		const run = f.driver.createRun(f.input);
		const pending = collect(run.events);
		await vi.waitFor(() => expect(f.prompt).toHaveBeenCalled());
		expect(await run.cancel('reset')).toEqual({ status: 'unconfirmed', reason: expect.stringContaining('not acknowledged') });
		await pending;
		expect(f.server.stop).not.toHaveBeenCalled();
		await f.driver.disconnect();
		f.cleanup();
	});

	it('waits for server.connected before submitting, even after subscribe returns', async () => {
		const f = fixture();
		let release!: () => void;
		f.subscribe.mockImplementationOnce(async () => ({ stream: { async *[Symbol.asyncIterator]() {
			await new Promise<void>((resolve) => { release = resolve; });
			yield { type: 'server.connected', properties: {} };
			while (true) await new Promise<void>(() => {});
		} } }));
		const run = f.driver.createRun(f.input);
		const pending = collect(run.events);
		await vi.waitFor(() => expect(release).toBeTypeOf('function'));
		expect(f.prompt).not.toHaveBeenCalled();
		await run.cancel('pre-submit');
		release();
		expect((await pending).at(-1)?.type).toBe('cancelled');
		expect(f.prompt).not.toHaveBeenCalled();
		f.cleanup();
	});

	it('rejects another conversation in same directory before submitting', async () => {
		const f = fixture();
		const pending = collect(f.driver.createRun(f.input).events);
		await vi.waitFor(() => expect(f.prompt).toHaveBeenCalled());
		const other = { ...f.input, conversation: { ...f.input.conversation, id: 'other-conversation' } };
		expect(await collect(f.driver.createRun(other).events)).toEqual([{ type: 'error', message: expect.stringContaining('PROMPT_SCOPE_CONFLICT') }]);
		f.emit({ type: 'session.idle', properties: { sessionID: 's1' } });
		f.complete();
		await pending;
		f.cleanup();
	});

	it('abort true and idle still require runtime stop verification', async () => {
		const f = fixture();
		const run = f.driver.createRun(f.input);
		const pending = collect(run.events);
		await vi.waitFor(() => expect(f.prompt).toHaveBeenCalled());
		expect(await run.cancel('reset')).toEqual({ status: 'unconfirmed', reason: expect.stringContaining('stop not verified') });
		await pending;
		f.cleanup();
	});

	it('aborted preparation cannot submit after asynchronous setup resolves', async () => {
		const f = fixture();
		let release!: () => void;
		f.subscribe.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { release = resolve; }); return { stream: { async *[Symbol.asyncIterator]() {} } }; });
		const run = f.driver.createRun(f.input);
		const pending = collect(run.events);
		await vi.waitFor(() => expect(f.subscribe).toHaveBeenCalled());
		expect(await run.cancel('timeout')).toEqual({ status: 'stopped' });
		release();
		expect(await pending).toEqual([{ type: 'cancelled', reason: 'Cancelled before submission' }]);
		expect(f.prompt).not.toHaveBeenCalled();
		f.cleanup();
	});
});
