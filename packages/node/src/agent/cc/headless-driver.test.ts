import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CcHeadlessDriver, type CcChild, type CcHeadlessDriverDeps, type CcSpawnOptions } from './headless-driver.js';
import type { AgentEvent, PreparedRun } from '../events.js';
import { CcSessionRegistry } from './sink.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function fixture(overrides: Partial<CcHeadlessDriverDeps> = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'cc-native-'));
	dirs.push(dir);
	const output = new EventEmitter();
	const errors = new EventEmitter();
	const process = new EventEmitter();
	const writes: string[] = [];
	const child = Object.assign(process, {
		pid: 4242,
		stdin: { write: (s: string) => { writes.push(s); }, end: vi.fn() },
		stdout: output, stderr: errors, kill: vi.fn(() => true),
	}) as unknown as CcChild;
	let groupAlive = true;
	const kill = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
		if (pid !== -4242) throw new Error('wrong group');
		if (signal === 0 && !groupAlive) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
	});
	const registry = new CcSessionRegistry();
	const spawnCalls: Array<{ args: readonly string[]; options: CcSpawnOptions }> = [];
	const transcript = vi.fn();
	const driver = new CcHeadlessDriver({ workspaceBase: dir, brokerPort: 9100,
		registerHook: (key, id, push) => registry.registerContext(key, id, push),
		transcript: { append: transcript },
		spawn: (_cmd, args, options) => { spawnCalls.push({ args, options }); return child; },
		kill, platform: 'linux', firstEventTimeoutMs: 500, stopTimeoutMs: 180, killGraceMs: 10, drainMs: 0,
		...overrides });
	const persisted: Array<unknown> = [];
	const controller = new AbortController();
	const input: PreparedRun = { runId: 'core-run', message: '[HuLa 群聊]\nAlice(1): hi',
		workspace: dir, transcriptKey: 'aiclaw-5-room-9', contextKey: 'opaque-new-key', bindToken: 'opaque-legacy-alias',
		systemPrompt: 'system instructions',
		conversation: { id: 'opaque-conversation', generation: 1, nativeState: undefined,
			assertCurrent: vi.fn(), saveNativeState: async (v) => { persisted.push(v); },
			registerNativeAlias: vi.fn(async () => {}) },
		saveRecovery: vi.fn(async () => {}), capabilities: { invoke: vi.fn(async () => {}) }, signal: controller.signal };
	const start = async (runInput = input) => {
		const run = driver.createRun(runInput);
		const collected: AgentEvent[] = [];
		const done = (async () => { for await (const event of run.events) collected.push(event); })();
		for (let i = 0; i < 30 && !spawnCalls.length; i++) await tick();
		return { run, collected, done };
	};
	return { dir, driver, input, controller, start, spawnCalls, output, errors, process, writes,
		persisted, registry, transcript, kill,
		groupExit: () => { groupAlive = false; }, close: (code: number | null) => { process.emit('close', code, null); },
		line: (value: object) => output.emit('data', `${JSON.stringify(value)}\n`) };
}

// POSIX group probes need the native -pgid API; on Windows this driver deliberately cannot confirm stop.
const posix = it;

describe('CC PreparedRun native execution', () => {
	posix('starts only on consumption, uses opaque core capability key, persists historical session, keeps transcript path', async () => {
		const f = fixture();
		f.input.conversation.nativeState = { version: 1, value: { sessionId: 'historical-id', workspace: f.dir } };
		const run = f.driver.createRun(f.input);
		expect(f.spawnCalls).toHaveLength(0);
		const events: AgentEvent[] = [];
		const done = (async () => { for await (const event of run.events) events.push(event); })();
		for (let i = 0; i < 30 && !f.spawnCalls.length; i++) await tick();
		expect(f.spawnCalls[0].args).toContain('historical-id');
		expect(f.spawnCalls[0].args).toContain('system instructions');
		expect(f.spawnCalls[0].options.env.AICHAT_CONTEXT_KEY).toBe('opaque-new-key');
		expect(f.spawnCalls[0].options.env.AICHAT_BIND).toBe('opaque-legacy-alias');
		expect(f.spawnCalls[0].options.env.OPENCODE_SESSION_ID).toBeUndefined();
		expect(JSON.parse(f.writes[0]).message.content[0].text).toBe(f.input.message);
		expect(f.transcript).toHaveBeenCalledWith('aiclaw-5-room-9', expect.objectContaining({ kind: 'inbound' }));
		f.line({ type: 'system', subtype: 'init', session_id: 'historical-id' });
		f.line({ type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] } });
		f.registry.pushContext('opaque-new-key', f.spawnCalls[0].options.env.AICHAT_CC_RUN!, { type: 'tool', name: 'Bash', phase: 'end' });
		f.line({ type: 'result', is_error: false });
		await tick();
		expect(events.some((e) => e.type === 'done')).toBe(false); // result != child close
		f.groupExit(); f.close(0);
		await done;
		expect(events.map((e) => e.type)).toEqual(['thinking', 'tool', 'done']);
		expect(f.persisted).toEqual([{ version: 1, value: { sessionId: 'historical-id', workspace: f.dir } }]);
		expect(f.input.saveRecovery).toHaveBeenCalledWith(expect.objectContaining({ value: expect.objectContaining({ pid: 4242 }) }));
	});

	posix('does not finish on EOF or close while a descendant survives; cancel remains unconfirmed', async () => {
		const f = fixture();
		const { run, collected, done } = await f.start();
		f.line({ type: 'result', is_error: false });
		f.output.emit('end');
		await tick();
		expect(collected.some((event) => event.type === 'done')).toBe(false);
		f.close(0);
		await done;
		expect(collected).toEqual([expect.objectContaining({ type: 'cancelled' })]);
		expect(await run.cancel('probe')).toEqual(expect.objectContaining({ status: 'unconfirmed' }));
		expect(f.kill).toHaveBeenCalledWith(-4242, 'SIGTERM');
		expect(f.kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
	});

	posix('requires child close AND group disappearance to confirm cancellation; no immediate resume retry', async () => {
		const f = fixture();
		f.input.conversation.nativeState = { version: 1, value: { sessionId: 'history', workspace: f.dir } };
		const { run, done } = await f.start();
		const stop = run.cancel('reset');
		f.groupExit();
		await tick();
		expect(f.spawnCalls).toHaveLength(1);
		f.close(null);
		expect(await stop).toEqual({ status: 'stopped' });
		await done;
		expect(f.spawnCalls).toHaveLength(1);
	});

	posix('error result never triggers another spawn or a done terminal', async () => {
		const f = fixture();
		f.input.conversation.nativeState = { version: 1, value: { sessionId: 'history', workspace: f.dir } };
		const { collected, done } = await f.start();
		f.line({ type: 'result', is_error: true, errors: ['session invalid'] });
		f.groupExit(); f.close(1);
		await done;
		expect(collected).toEqual([expect.objectContaining({ type: 'error' })]);
		expect(f.spawnCalls).toHaveLength(1);
	});

	posix('does not spawn a never-consumed run during disconnect', async () => {
		const f = fixture();
		f.driver.createRun(f.input);
		await f.driver.disconnect();
		expect(f.spawnCalls).toHaveLength(0);
	});

	it('rejects a stale generation and abort before native stdin submission', async () => {
		const stale = fixture();
		vi.mocked(stale.input.conversation.assertCurrent).mockImplementation(() => { throw new Error('STALE_GENERATION'); });
		const staleRun = stale.driver.createRun(stale.input);
		const staleEvents: AgentEvent[] = [];
		for await (const ev of staleRun.events) staleEvents.push(ev);
		expect(stale.spawnCalls).toHaveLength(0);
		expect(staleEvents).toEqual([expect.objectContaining({ type: 'error', message: 'STALE_GENERATION' })]);
		const aborted = fixture();
		aborted.controller.abort();
		const abortedRun = aborted.driver.createRun(aborted.input);
		const abortedEvents: AgentEvent[] = [];
		for await (const ev of abortedRun.events) abortedEvents.push(ev);
		expect(aborted.spawnCalls).toHaveLength(0);
		expect(abortedEvents).toEqual([expect.objectContaining({ type: 'cancelled' })]);
	});

	posix('does not submit stdin if process recovery cannot be persisted', async () => {
		const f = fixture();
		vi.mocked(f.input.saveRecovery).mockRejectedValueOnce(new Error('disk full'));
		const events: AgentEvent[] = [];
		for await (const ev of f.driver.createRun(f.input).events) events.push(ev);
		expect(f.spawnCalls).toHaveLength(0);
		expect(f.writes).toHaveLength(0);
		expect(events).toEqual([expect.objectContaining({ type: 'error', message: 'disk full' })]);
	});

	it('reports synchronous spawn failure once without writing stdin or leaving a hook', async () => {
		const f = fixture({ spawn: () => { throw new Error('ENOENT claude'); } });
		const events: AgentEvent[] = [];
		for await (const event of f.driver.createRun(f.input).events) events.push(event);
		expect(events).toEqual([expect.objectContaining({ type: 'error', message: 'ENOENT claude' })]);
		expect(f.writes).toHaveLength(0);
		f.registry.pushContext('opaque-new-key', 'core-run:unknown', { type: 'tool', name: 'late', phase: 'end' });
	});

	posix('first-event watchdog cannot turn a live process into a confirmed success', async () => {
		const f = fixture({ firstEventTimeoutMs: 5, stopTimeoutMs: 40, killGraceMs: 5 });
		const { collected, done } = await f.start();
		await done;
		expect(collected).toEqual([expect.objectContaining({ type: 'cancelled', reason: 'CC stop unconfirmed' })]);
		expect(f.kill).toHaveBeenCalledWith(-4242, 'SIGTERM');
		expect(f.spawnCalls).toHaveLength(1);
	});

	posix('keeps tool transcript truncation explicit and never duplicates a terminal event', async () => {
		const f = fixture();
		const { collected, done } = await f.start();
		f.line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { script: 'x'.repeat(3000) } }] } });
		f.line({ type: 'result', is_error: false });
		f.line({ type: 'result', is_error: false });
		f.groupExit(); f.close(0);
		await done;
		expect(collected).toEqual([expect.objectContaining({ type: 'done' })]);
		const tool = f.transcript.mock.calls.find((call) => (call[1] as { kind?: string }).kind === 'tool_use');
		expect((tool?.[1] as { tool_input: string }).tool_input).toContain('…[truncated ');
	});

	posix('drops a late hook after completion without selecting a replacement run', async () => {
		const f = fixture();
		const { collected, done } = await f.start();
		const runId = f.spawnCalls[0].options.env.AICHAT_CC_RUN!;
		f.line({ type: 'result', is_error: false });
		f.groupExit(); f.close(0);
		await done;
		f.registry.pushContext('opaque-new-key', runId, { type: 'tool', name: 'late', phase: 'end' });
		expect(collected).toEqual([expect.objectContaining({ type: 'done' })]);
	});

	posix('disconnect waits for active process-group proof and never treats child close alone as stopped', async () => {
		const f = fixture();
		const { collected, done } = await f.start();
		const disconnect = f.driver.disconnect();
		await tick();
		expect(f.kill).toHaveBeenCalledWith(-4242, 'SIGTERM');
		f.close(null);
		await tick();
		f.groupExit();
		await disconnect; await done;
		expect(collected).not.toContainEqual(expect.objectContaining({ type: 'done' }));
	});

	posix('never re-kills a normally completed job on disconnect', async () => {
		const f = fixture();
		const { done } = await f.start();
		f.line({ type: 'result', is_error: false });
		f.groupExit(); f.close(0);
		await done;
		await f.driver.disconnect();
		expect(f.kill).not.toHaveBeenCalledWith(-4242, 'SIGTERM');
		expect(f.kill).not.toHaveBeenCalledWith(-4242, 'SIGKILL');
	});

	posix('bounds a newline-free stdout stream and stops instead of exhausting memory', async () => {
		const f = fixture();
		const { collected, done } = await f.start();
		f.output.emit('data', 'x'.repeat(8 * 1024 * 1024 + 1));
		await tick();
		f.groupExit(); f.close(1);
		await done;
		expect(collected).toContainEqual(expect.objectContaining({ type: 'error', message: 'CC stdout line exceeded 8 MiB' }));
		expect(collected).not.toContainEqual(expect.objectContaining({ type: 'done' }));
	});

	posix('rejects missing original cwd even when current workspace exists, without spawning', async () => {
		const f = fixture();
		f.input.conversation.nativeState = { version: 1, value: { sessionId: 'history' } };
		const run = f.driver.createRun(f.input);
		const events: AgentEvent[] = [];
		for await (const event of run.events) events.push(event);
		expect(events).toEqual([expect.objectContaining({ type: 'error', message: expect.stringContaining('original cwd unconfirmed') })]);
		expect(f.spawnCalls).toHaveLength(0);
	});

	posix('rejects workspace mismatch without submitting a different native history', async () => {
		const f = fixture();
		f.input.conversation.nativeState = { version: 1, value: { sessionId: 'history', workspace: '/other' } };
		const run = f.driver.createRun(f.input);
		const events: AgentEvent[] = [];
		for await (const event of run.events) events.push(event);
		expect(events).toEqual([expect.objectContaining({ type: 'error', message: expect.stringContaining('original cwd unconfirmed') })]);
		expect(f.spawnCalls).toHaveLength(0);
	});
});
