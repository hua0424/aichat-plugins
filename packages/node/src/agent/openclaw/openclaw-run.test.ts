import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import type { AgentEvent, PreparedRun, RunDriver } from '../events.js';
import { OpenclawDriver } from './openclaw-driver.js';

const binding = 'aiclaw-9007199254740993-room-9007199254740995';
const oldToken = 'a'.repeat(64);
const freshToken = 'b'.repeat(64);
const oldRef = `${oldToken}:${binding}`;
const oldState = { token: oldToken, nativeRef: oldRef };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function collect(events: AsyncIterable<AgentEvent>) {
	const result: AgentEvent[] = [];
	for await (const event of events) result.push(event);
	return result;
}

class Socket extends EventEmitter {
	readonly sent: Array<{ id: string; method: string; params: Record<string, unknown> }> = [];
	closed = false;
	send(data: string) {
		const frame = JSON.parse(data) as (typeof this.sent)[number];
		this.sent.push(frame);
		if (frame.method === 'connect') queueMicrotask(() => this.deliver({ type: 'res', id: frame.id, ok: true, payload: { type: 'hello-ok', protocol: 4 } }));
	}
	close(code = 1000, reason = '') {
		if (this.closed) return;
		this.closed = true;
		this.emit('close', code, Buffer.from(reason));
	}
	deliver(frame: unknown) { this.emit('message', Buffer.from(JSON.stringify(frame))); }
	accept(request: (typeof this.sent)[number], runId: string) {
		this.deliver({ type: 'res', id: request.id, ok: true, payload: { status: 'accepted', runId } });
	}
	end(runId: string) {
		this.deliver({ type: 'event', event: 'agent', payload: { runId, seq: 1, stream: 'lifecycle', ts: Date.now(), data: { phase: 'end' } } });
	}
	get agents() { return this.sent.filter((frame) => frame.method === 'agent'); }
}

function fixture(nativeState?: unknown) {
	const workspace = mkdtempSync(join(tmpdir(), 'openclaw-native-run-'));
	const sockets: Socket[] = [];
	let native = nativeState;
	const registerNative = vi.fn(async (_id: string, state: { value: unknown }) => { native = state.value; });
	const input: PreparedRun = {
		runId: 'core-run-1', message: 'raw user message', systemPrompt: 'persona one',
		contextKey: freshToken, transcriptKey: binding,
		conversation: {
			id: 'core-conversation-1', generation: 1,
			get nativeState() { return native === undefined ? undefined : { version: 1, value: native }; },
			assertCurrent: vi.fn(), saveNativeState: vi.fn(), registerNativeAlias: vi.fn(), registerNative,
		},
		signal: new AbortController().signal, saveRecovery: vi.fn(), capabilities: { invoke: vi.fn() },
	};
	const factory = (): WebSocket => {
		const socket = new Socket();
		sockets.push(socket);
		queueMicrotask(() => {
			socket.emit('open');
			socket.deliver({ type: 'event', event: 'connect.challenge', payload: { nonce: 'challenge' } });
		});
		return socket as unknown as WebSocket;
	};
	const driver = () => new OpenclawDriver('ws://localhost:18789', '', factory, workspace) as RunDriver;
	return { input, workspace, registerNative, sockets, driver, get native() { return native; },
		set native(value: unknown) { native = value; }, cleanup: () => rmSync(workspace, { recursive: true, force: true }) };
}

describe('native OpenClaw AgentRun (#303)', () => {
	it('resumes an exact historical compound nativeRef without minting or rewriting it', async () => {
		const f = fixture(oldState);
		const driver = f.driver();
		try {
			await driver.connect();
			const socket = f.sockets[0];
			const pending = collect(driver.createRun(f.input).events);
			await vi.waitFor(() => expect(socket.agents).toHaveLength(1));
			const request = socket.agents[0];
			expect(request.params).toEqual(expect.objectContaining({ message: 'raw user message', sessionKey: oldRef }));
			expect(f.registerNative).not.toHaveBeenCalled();
			socket.accept(request, 'gateway-run-old');
			socket.end('gateway-run-old');
			expect(await pending).toEqual([{ type: 'done', durationMs: expect.any(Number) }]);
			expect(f.native).toEqual(oldState);
		} finally { await driver.disconnect(); f.cleanup(); }
	});

	it('registers a fresh compound nativeRef with core before submission, and keeps it on restart', async () => {
		const f = fixture();
		const first = f.driver();
		try {
			await first.connect();
			const socket = f.sockets[0];
			const pending = collect(first.createRun(f.input).events);
			await vi.waitFor(() => expect(socket.agents).toHaveLength(1));
			const ref = `${freshToken}:${binding}`;
			expect(f.registerNative).toHaveBeenCalledWith(freshToken, { version: 1, value: { token: freshToken, nativeRef: ref } });
			expect(socket.agents[0].params.sessionKey).toBe(ref);
			socket.accept(socket.agents[0], 'gateway-run-1');
			socket.end('gateway-run-1');
			expect((await pending).at(-1)?.type).toBe('done');
			await first.disconnect();
			const restarted = f.driver();
			try {
				await restarted.connect();
				const again = collect(restarted.createRun({ ...f.input, runId: 'core-run-2' }).events);
				await vi.waitFor(() => expect(f.sockets[1].agents).toHaveLength(1));
				expect(f.sockets[1].agents[0].params.sessionKey).toBe(ref);
					expect(f.registerNative).toHaveBeenCalledTimes(1);
				f.sockets[1].accept(f.sockets[1].agents[0], 'gateway-run-2');
				f.sockets[1].end('gateway-run-2');
				expect((await again).at(-1)?.type).toBe('done');
			} finally { await restarted.disconnect(); }
		} finally { await first.disconnect(); f.cleanup(); }
	});

	it('waits for atomic core registration before the fresh gateway request', async () => {
		const f = fixture();
		let release!: () => void;
		f.registerNative.mockImplementationOnce(async (_id, state) => {
			await new Promise<void>((resolve) => { release = resolve; });
			f.native = state.value;
		});
		const driver = f.driver();
		try {
			await driver.connect();
			const socket = f.sockets[0];
			const pending = collect(driver.createRun(f.input).events);
			await vi.waitFor(() => expect(release).toBeTypeOf('function'));
			expect(socket.agents).toHaveLength(0);
			release();
			await vi.waitFor(() => expect(socket.agents).toHaveLength(1));
			socket.accept(socket.agents[0], 'registered-run');
			socket.end('registered-run');
			expect((await pending).at(-1)?.type).toBe('done');
		} finally { await driver.disconnect(); f.cleanup(); }
	});

	it('an explicit core reset (no nativeState) uses the new core key, not old history', async () => {
		const f = fixture(oldState);
		f.native = undefined; // core rotated generation and removed its old native claim
		f.input.conversation = { ...f.input.conversation, id: 'reset-conversation', generation: 2,
			get nativeState() { return f.native === undefined ? undefined : { version: 1, value: f.native }; } };
		const driver = f.driver();
		try {
			await driver.connect();
			const socket = f.sockets[0];
			const pending = collect(driver.createRun(f.input).events);
			await vi.waitFor(() => expect(socket.agents).toHaveLength(1));
			expect(socket.agents[0].params.sessionKey).not.toBe(oldRef);
			expect(f.registerNative).toHaveBeenCalledOnce();
			socket.accept(socket.agents[0], 'gateway-reset');
			socket.end('gateway-reset');
			await pending;
		} finally { await driver.disconnect(); f.cleanup(); }
	});

	it('rejects a second identity sharing the prompt workspace before gateway submission', async () => {
		const f = fixture(oldState);
		const driver = f.driver();
		try {
			await driver.connect();
			const socket = f.sockets[0];
			const first = collect(driver.createRun(f.input).events);
			await vi.waitFor(() => expect(socket.agents).toHaveLength(1));
			socket.accept(socket.agents[0], 'first');
			socket.end('first');
			await first;
			const other: PreparedRun = { ...f.input, runId: 'second', systemPrompt: 'different persona',
				conversation: { ...f.input.conversation, id: 'other-identity', nativeState: undefined } };
			expect(await collect(driver.createRun(other).events)).toEqual([
				{ type: 'error', message: expect.stringContaining('PROMPT_SCOPE_CONFLICT') },
			]);
			expect(socket.agents).toHaveLength(1);
		} finally { await driver.disconnect(); f.cleanup(); }
	});

	it('does not retain an in-memory prompt owner when core registration fails before submission', async () => {
		const f = fixture();
		f.registerNative.mockRejectedValueOnce(new Error('disk full'));
		const driver = f.driver();
		try {
			await driver.connect();
			expect((await collect(driver.createRun(f.input).events)).at(-1)).toEqual({ type: 'error', message: 'disk full' });
			const other: PreparedRun = { ...f.input, runId: 'other-run',
				conversation: { ...f.input.conversation, id: 'other-owner' } };
			const pending = collect(driver.createRun(other).events);
			await vi.waitFor(() => expect(f.sockets[0].agents).toHaveLength(1));
			f.sockets[0].accept(f.sockets[0].agents[0], 'other-gateway-run');
			f.sockets[0].end('other-gateway-run');
			expect((await pending).at(-1)?.type).toBe('done');
		} finally { await driver.disconnect(); f.cleanup(); }
	});

	it('pre-submit cancel never sends; stalled submitted gateway cannot claim a confirmed stop', async () => {
		const f = fixture(oldState);
		const driver = f.driver();
		try {
			await driver.connect();
			const socket = f.sockets[0];
			const early = driver.createRun(f.input);
			expect(await early.cancel('reset')).toEqual({ status: 'stopped' });
			expect(await collect(early.events)).toEqual([{ type: 'cancelled', reason: expect.any(String) }]);
			expect(socket.agents).toHaveLength(0);
			const run = driver.createRun({ ...f.input, runId: 'stalled' });
			const pending = collect(run.events);
			await vi.waitFor(() => expect(socket.agents).toHaveLength(1));
			const result = await run.cancel('reset');
			expect(result).toEqual({ status: 'unconfirmed', reason: expect.any(String) });
			expect(socket.closed).toBe(false); // shared gateway must remain available to other identities
			// A late lifecycle event may settle the stream, but cannot retroactively verify the earlier cancellation.
			socket.accept(socket.agents[0], 'stalled-run');
			socket.end('stalled-run');
			await tick();
			await run.dispose();
			await Promise.race([pending, new Promise<never>((_, reject) => setTimeout(() => reject(Error('cancelled run did not settle')), 1000))]);
		} finally { await driver.disconnect(); f.cleanup(); }
	});

	it('buffers pre-accepted events by gateway runId without assigning another pending room', async () => {
		const f = fixture(oldState);
		const driver = f.driver();
		try {
			await driver.connect();
			const socket = f.sockets[0];
			const first = collect(driver.createRun({ ...f.input, promptOwner: 'same-identity' }).events);
			const secondInput: PreparedRun = { ...f.input, runId: 'second', promptOwner: 'same-identity',
				conversation: { ...f.input.conversation, id: 'second-room', nativeState: undefined } };
			const second = collect(driver.createRun(secondInput).events);
			await vi.waitFor(() => expect(socket.agents).toHaveLength(2));
			// The second request's event arrives first, before either accepted response.
			socket.end('run-second');
			socket.accept(socket.agents[0], 'run-first');
			socket.end('run-first');
			socket.accept(socket.agents[1], 'run-second');
			expect((await first).at(-1)?.type).toBe('done');
			expect((await second).at(-1)?.type).toBe('done');
		} finally { await driver.disconnect(); f.cleanup(); }
	});

	it('fails closed when pre-accepted gateway events overflow instead of reporting a partial done', async () => {
		const f = fixture(oldState);
		const driver = f.driver();
		try {
			await driver.connect();
			const socket = f.sockets[0];
			const pending = collect(driver.createRun(f.input).events);
			await vi.waitFor(() => expect(socket.agents).toHaveLength(1));
			for (let i = 0; i < 65; i++) socket.deliver({ type: 'event', event: 'agent',
				payload: { runId: 'early-overflow', seq: i, stream: 'assistant', ts: Date.now(), data: { delta: 'x' } } });
			socket.end('early-overflow');
			socket.accept(socket.agents[0], 'early-overflow');
			expect((await pending).at(-1)).toEqual({ type: 'error', message: expect.stringContaining('EARLY_STREAM_OVERFLOW') });
		} finally { await driver.disconnect(); f.cleanup(); }
	});

	it('a disconnected gateway before send is a local error, not an unconfirmed submitted run', async () => {
		const f = fixture(oldState);
		const driver = f.driver();
		try {
			await driver.connect();
			f.sockets[0].close();
			const run = driver.createRun(f.input);
			expect((await collect(run.events)).at(-1)?.type).toBe('error');
			expect(await run.cancel('failure')).toEqual({ status: 'stopped' });
			expect(f.sockets[0].agents).toHaveLength(0);
		} finally { await driver.disconnect(); f.cleanup(); }
	});

	it('writes the already prepared system prompt verbatim to AGENTS.md while keeping gateway message pure', async () => {
		const f = fixture();
		f.input.systemPrompt = 'prepared {displayName}';
		const driver = f.driver();
		try {
			await driver.connect();
			const socket = f.sockets[0];
			const pending = collect(driver.createRun(f.input).events);
			await vi.waitFor(() => expect(socket.agents).toHaveLength(1));
			expect(socket.agents[0].params.message).toBe('raw user message');
			const agentsPath = join(f.workspace, 'AGENTS.md');
			expect(existsSync(agentsPath)).toBe(true);
			expect(readFileSync(agentsPath, 'utf8')).toBe('<!-- aichat:system:begin -->\nprepared {displayName}\n<!-- aichat:system:end -->\n');
			socket.accept(socket.agents[0], 'prepared-run');
			socket.end('prepared-run');
			await pending;
		} finally { await driver.disconnect(); f.cleanup(); }
	});

	it('5-minute backstop unblocks an abandoned native gateway run', async () => {
		const f = fixture(oldState);
		const driver = f.driver();
		await driver.connect();
		vi.useFakeTimers();
		try {
			const socket = f.sockets[0];
			const pending = collect(driver.createRun(f.input).events);
			await vi.waitFor(() => expect(socket.agents).toHaveLength(1));
			socket.accept(socket.agents[0], 'abandoned');
			await Promise.resolve();
			const maps = driver as unknown as { activeChats: Map<string, unknown>; pending: Map<string, unknown>;
				requestToRunId: Map<string, unknown> };
			expect(maps.activeChats.size).toBeGreaterThan(0);
			vi.advanceTimersByTime(5 * 60 * 1000 + 1);
			expect((await pending).at(-1)).toEqual({ type: 'error', message: 'openclaw_chat_timeout' });
			expect(maps.activeChats.size).toBe(0);
			expect(maps.pending.size).toBe(0);
			expect(maps.requestToRunId.size).toBe(0);
		} finally { vi.useRealTimers(); await driver.disconnect(); f.cleanup(); }
	});

	it('a normal lifecycle end clears the abandoned-run timer and all gateway maps', async () => {
		const f = fixture(oldState);
		const driver = f.driver();
		await driver.connect();
		vi.useFakeTimers();
		try {
			const socket = f.sockets[0];
			const pending = collect(driver.createRun(f.input).events);
			await vi.waitFor(() => expect(socket.agents).toHaveLength(1));
			socket.accept(socket.agents[0], 'completed');
			socket.end('completed');
			expect(await pending).toEqual([{ type: 'done', durationMs: expect.any(Number) }]);
			const maps = driver as unknown as { activeChats: Map<string, unknown>; pending: Map<string, unknown>;
				requestToRunId: Map<string, unknown> };
			expect([maps.activeChats.size, maps.pending.size, maps.requestToRunId.size]).toEqual([0, 0, 0]);
			vi.advanceTimersByTime(5 * 60 * 1000 + 1);
			expect([maps.activeChats.size, maps.pending.size, maps.requestToRunId.size]).toEqual([0, 0, 0]);
		} finally { vi.useRealTimers(); await driver.disconnect(); f.cleanup(); }
	});

	it('native cancel wakes a parked event consumer without a gateway terminal or closing the shared socket', async () => {
		const f = fixture(oldState);
		const driver = f.driver();
		try {
			await driver.connect();
			const socket = f.sockets[0];
			const run = driver.createRun(f.input);
			const received: AgentEvent[] = [];
			const pending = collect(run.events).then((events) => received.push(...events));
			await vi.waitFor(() => expect(socket.agents).toHaveLength(1));
			socket.accept(socket.agents[0], 'no-terminal');
			await tick(); // consumer is now parked in the event iterator
			expect(await run.cancel('reset')).toEqual({ status: 'unconfirmed', reason: expect.any(String) });
			await Promise.race([pending, new Promise<never>((_, reject) => setTimeout(() => reject(Error('cancel did not wake iterator')), 1000))]);
			expect(received).toEqual([{ type: 'cancelled', reason: 'OpenClaw stop not confirmed' }]);
			expect(socket.closed).toBe(false);
		} finally { await driver.disconnect(); f.cleanup(); }
	});

	it('maps buffered gateway thinking and error frames to native run events', async () => {
		const f = fixture(oldState);
		const driver = f.driver();
		try {
			await driver.connect();
			const socket = f.sockets[0];
			const run = driver.createRun(f.input);
			const pending = collect(run.events);
			await vi.waitFor(() => expect(socket.agents).toHaveLength(1));
			socket.accept(socket.agents[0], 'stream-run');
			for (const [seq, delta] of ['foo', 'bar'].entries()) socket.deliver({ type: 'event', event: 'agent',
				payload: { runId: 'stream-run', seq: seq + 1, stream: 'assistant', ts: Date.now(), data: { delta } } });
			socket.deliver({ type: 'event', event: 'agent', payload: { runId: 'stream-run', seq: 3,
				stream: 'lifecycle', ts: Date.now(), data: { phase: 'error', error: 'boom' } } });
			expect(await pending).toEqual([{ type: 'thinking', text: 'foo' }, { type: 'thinking', text: 'bar' },
				{ type: 'error', message: 'boom' }]);
		} finally { await driver.disconnect(); f.cleanup(); }
	});

	it('only the correlated lifecycle end is terminal (accepted and thinking alone are not)', async () => {
		const f = fixture(oldState);
		const driver = f.driver();
		try {
			await driver.connect();
			const socket = f.sockets[0];
			const result: AgentEvent[] = [];
			let finished = false;
			const pending = collect(driver.createRun(f.input).events).then((events) => { result.push(...events); finished = true; });
			await vi.waitFor(() => expect(socket.agents).toHaveLength(1));
			socket.accept(socket.agents[0], 'this-run');
			socket.deliver({ type: 'event', event: 'agent', payload: { runId: 'this-run', seq: 1, stream: 'assistant', ts: Date.now(), data: { delta: 'thought' } } });
			await tick();
			expect(finished).toBe(false);
			socket.end('some-other-run');
			await tick();
			expect(finished).toBe(false);
			socket.end('this-run');
			await pending;
			expect(result).toEqual([{ type: 'thinking', text: 'thought' }, { type: 'done', durationMs: expect.any(Number) }]);
		} finally { await driver.disconnect(); f.cleanup(); }
	});
});
