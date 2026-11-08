import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpencodeClient } from '@opencode-ai/sdk';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../events.js';
import { NativeInputRun } from './native-input.js';

const SID = 'ses_test';

const deferred = <T>() => {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
};

type Info = Record<string, unknown>;
const assistant = (over: Info = {}): Info => ({
	sessionID: SID, role: 'assistant', id: `m_${randomBytes(4).toString('hex')}`,
	parentID: 'msg_other', finish: 'stop', time: { completed: Date.now() }, error: null, ...over,
});
const row = (info: Info, parts: unknown[] = []) => ({ info, parts });

interface Handles {
	sse(value: unknown): void;
	sseClose(): void;
	resolveCommand(value: unknown): void;
	rejectCommand(error: unknown): void;
	resolveMessages(value: unknown): void;
}

function makeClient() {
	const command = deferred<unknown>(), messages = deferred<unknown>();
	const queue: unknown[] = [];
	let wake: (() => void) | undefined, closed = false;
	const stream = {
		[Symbol.asyncIterator]: () => ({
			next: async () => {
				for (;;) {
					if (queue.length) return { value: queue.shift(), done: false };
					if (closed) return { value: undefined, done: true };
					await new Promise<void>((resolve) => { wake = resolve; });
				}
			},
		}),
	};
	const sse = (value: unknown) => { if (closed) return; queue.push(value); wake?.(); wake = undefined; };
	const client = {
		event: { subscribe: async () => { sse({ type: 'server.connected' }); return { stream }; } },
		session: {
			command: async () => command.promise,
			messages: async () => messages.promise,
			abort: async () => true,
		},
	};
	const handles: Handles = {
		sse,
		sseClose: () => { closed = true; wake?.(); wake = undefined; },
		resolveCommand: (value) => command.resolve(value),
		rejectCommand: (error) => command.reject(error),
		resolveMessages: (value) => messages.resolve(value),
	};
	return { client: client as unknown as OpencodeClient, handles };
}

async function runScenario(script: (handles: Handles, own: string) => void) {
	const bindDir = await mkdtemp(join(tmpdir(), 'native-input-test-'));
	const { client, handles } = makeClient();
	const conversation = {
		id: 'conv_test', generation: 1, assertCurrent() {}, saveNativeState: async () => {},
		registerNativeAlias: async () => {},
	};
	const prepared = {
		runId: `run_${randomBytes(4).toString('hex')}`, message: '/skill:probe', workspace: '/tmp/ws',
		systemPrompt: 'diag', conversation, saveRecovery: async () => {},
		capabilities: { invoke: async () => undefined }, signal: new AbortController().signal,
	};
	const execution = {
		requestId: `req_${randomBytes(4).toString('hex')}`, conversation, systemPrompt: 'diag',
		contextKey: 'k', promptOwner: 'p', authorizationEpoch: 'e',
		submitted: async () => {}, selectModel: async () => {}, replaceSession: async () => 1,
		emit: async () => {},
		bindTurn: async () => ({ token: randomBytes(32).toString('hex'), runId: 'run_bind', thinkingId: 'th' }),
	};
	const run = new NativeInputRun(prepared as never, {
		client, session: async () => SID, runBindDir: bindDir, finished() {},
	}, { name: 'skill:probe', execution: execution as never });
	const own = run.inputID;
	const events: AgentEvent[] = [];
	let resolveTerminal!: (event: AgentEvent) => void;
	const terminal = new Promise<AgentEvent>((resolve) => { resolveTerminal = resolve; });
	const consume = (async () => {
		for await (const event of run.events) {
			events.push(event);
			if (event.type === 'done' || event.type === 'error' || event.type === 'cancelled') {
				resolveTerminal(event);
				return;
			}
		}
	})();
	script(handles, own);
	const terminalEvent = await Promise.race([
		terminal,
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error('scenario timeout')), 3000)),
	]);
	await consume.catch(() => {});
	await run.dispose();
	await rm(bindDir, { recursive: true, force: true });
	return { events, terminal: terminalEvent };
}

describe('NativeInputRun readback race', () => {
	it('settles done when own history completion is visible', async () => {
		const { terminal } = await runScenario((handles, own) => {
			handles.resolveCommand({ data: { info: assistant(), parts: [] } });
			handles.resolveMessages({ data: [row(assistant()), row(assistant({ id: 'own_A1', parentID: own }))] });
		});
		expect(terminal.type).toBe('done');
	});

	it('keeps observing after a history snapshot with only an in-progress own assistant, then settles on later SSE completion', async () => {
		const { terminal } = await runScenario((handles, own) => {
			handles.resolveCommand({ data: { info: assistant(), parts: [] } });
			handles.resolveMessages({
				data: [row(assistant()), row(assistant({ id: 'own_B1', parentID: own, finish: 'tool-calls', time: {} }))],
			});
			setTimeout(() => handles.sse({
				type: 'message.updated',
				properties: { info: assistant({ id: 'own_B1', parentID: own }) },
			}), 150);
		});
		expect(terminal.type).toBe('done');
	});

	it('preserves unknown when the SSE stream closes before any own completion', async () => {
		const { terminal } = await runScenario((handles) => {
			setTimeout(() => handles.sseClose(), 150);
		});
		expect(terminal.type).toBe('error');
		expect(terminal.type === 'error' ? terminal.message : '').toContain('native SSE closed');
	});

	it('preserves unknown when the command HTTP request fails', async () => {
		const { terminal } = await runScenario((handles) => {
			setTimeout(() => handles.rejectCommand(new Error('ECONNRESET (test)')), 150);
		});
		expect(terminal.type).toBe('error');
		expect(terminal.type === 'error' ? terminal.message : '').toContain('native request outcome unavailable');
	});
});
