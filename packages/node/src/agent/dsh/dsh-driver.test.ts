import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DshHeadlessDriver, DSH_EXPECTED_VERSION, type DshChild, type DshHeadlessDriverDeps, type DshSpawnOptions } from './dsh-driver.js';
import type { AgentEvent, PreparedRun } from '../events.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const promptHash = (prompt: string) => createHash('sha256').update(prompt).digest('hex');

function fixture(overrides: Partial<DshHeadlessDriverDeps> = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'dsh-native-'));
	dirs.push(dir);
	const output = new EventEmitter();
	const errors = new EventEmitter();
	const process = new EventEmitter();
	const writes: string[] = [];
	const child = Object.assign(process, {
		pid: 4242,
		stdin: { write: (s: string) => { writes.push(s); }, end: vi.fn() },
		stdout: output, stderr: errors, kill: vi.fn(() => true),
	}) as unknown as DshChild;
	let groupAlive = true;
	const kill = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
		if (pid !== -4242) throw new Error('wrong group');
		if (signal === 0 && !groupAlive) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
	});
	const spawnCalls: Array<{ cmd: string; args: readonly string[]; options: DshSpawnOptions }> = [];
	const driver = new DshHeadlessDriver({ spawn: (cmd, args, options) => {
		spawnCalls.push({ cmd, args, options });
		if (args[0] === '--version') {
			queueMicrotask(() => {
				output.emit('data', `${DSH_EXPECTED_VERSION}\n`);
				process.emit('close', 0, null);
			});
		}
		return child;
	}, kill, platform: 'linux', firstEventTimeoutMs: 500, stopTimeoutMs: 180, killGraceMs: 10, ...overrides });
	const persisted: Array<unknown> = [];
	const recovered: Array<unknown> = [];
	const controller = new AbortController();
	const input: PreparedRun = { runId: 'core-run', message: '[HuLa 私聊]\nAlice(1): hi',
		workspace: dir, contextKey: 'opaque-new-key', replyToken: 'f'.repeat(64),
		systemPrompt: 'system instructions',
		conversation: { id: 'opaque-conversation', generation: 1, nativeState: undefined,
			assertCurrent: vi.fn(), saveNativeState: async (v) => { persisted.push(v); },
			registerNativeAlias: vi.fn(async () => {}) },
		saveRecovery: vi.fn(async (v) => { recovered.push(v); }),
		capabilities: { invoke: vi.fn(async () => {}) }, signal: controller.signal };
	const start = async (runInput = input) => {
		const run = driver.createRun(runInput);
		const collected: AgentEvent[] = [];
		const done = (async () => { for await (const event of run.events) collected.push(event); })();
		for (let i = 0; i < 30 && !spawnCalls.length; i++) await tick();
		return { run, collected, done };
	};
	return { dir, driver, input, controller, start, spawnCalls, output, errors, process, writes,
		persisted, recovered, kill,
		groupExit: () => { groupAlive = false; }, close: (code: number | null) => { process.emit('close', code, null); },
		line: (value: object) => output.emit('data', `${JSON.stringify(value)}\n`) };
}

describe('DSH PreparedRun native execution', () => {
	it('connect gates the pinned headless version, isolating only this identity on mismatch', async () => {
		const ok = fixture();
		await expect(ok.driver.connect()).resolves.toBeUndefined();
		const bad = fixture({ spawn: (((cmd: string, args: readonly string[], options: DshSpawnOptions) => {
			const child = new EventEmitter() as unknown as DshChild;
			queueMicrotask(() => {
				(child.stdout as unknown as EventEmitter | null)?.emit?.('data', '0.0.0\n');
				child.emit('close', 0, null);
			});
			return Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(),
				stdin: null, kill: () => true });
		}) as unknown as DshHeadlessDriverDeps['spawn']), expectedVersion: '9.9.9' });
		await expect(bad.driver.connect()).rejects.toThrow('dsh version mismatch');
	});

	it('first run submits task via stdin with frozen bindings, streams thinking/tools, dedups intact final', async () => {
		const f = fixture();
		const saved = process.env.OPENCODE_SESSION_ID;
		process.env.OPENCODE_SESSION_ID = 'other-session';
		try {
			const { collected, done } = await f.start();
			expect(f.spawnCalls[0].cmd).toBe('dsh');
			expect(f.spawnCalls[0].args).toEqual(['--profile', 'headless', '--json', '-']);
			expect(f.spawnCalls[0].options.cwd).toBe(f.dir);
			expect(f.spawnCalls[0].options.env.AICHAT_CONTEXT_KEY).toBe('opaque-new-key');
			expect(f.spawnCalls[0].options.env.AICHAT_RUN_BIND).toBe('f'.repeat(64));
			expect(f.spawnCalls[0].options.env.DSH_SESSION_ID).toBeUndefined();
			expect(f.spawnCalls[0].options.env.OPENCODE_SESSION_ID).toBeUndefined();
			expect(f.writes[0]).toBe(`system instructions\n\n${f.input.message}\n`);
			f.line({ type: 'session', sessionId: 'session-1', cwd: f.dir });
			f.line({ type: 'thinking', text: 'reasoning…' });
			f.line({ type: 'text', text: 'answer' });
			f.line({ type: 'tool_call', callId: 'c1', tool: 'bash', input: { command: 'x' } });
			f.line({ type: 'tool_result', callId: 'c1', status: 'completed', result: 'ok' });
			f.line({ type: 'final', text: 'answer' });
			f.line({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } });
			f.groupExit(); f.close(0);
			await done;
			expect(collected).toEqual([
				{ type: 'thinking', text: 'reasoning…' },
				{ type: 'thinking', text: 'answer' },
				{ type: 'tool', name: 'bash', phase: 'start' },
				{ type: 'tool', name: 'bash', phase: 'end' },
				// intact final adds no bytes beyond the streamed text — yielded once, not twice.
				{ type: 'done', durationMs: expect.any(Number) },
			]);
			expect(f.persisted).toEqual([{ version: 1, value: { sessionId: 'session-1',
				workspace: f.dir, promptHash: promptHash('system instructions') } }]);
			expect(f.recovered[0]).toEqual(expect.objectContaining({ value: expect.objectContaining({ provider: 'dsh' }) }));
		} finally {
			if (saved === undefined) delete process.env.OPENCODE_SESSION_ID;
			else process.env.OPENCODE_SESSION_ID = saved;
		}
	});

	it('yields the lossless final when the stream was truncated or textless', async () => {
		const f = fixture();
		const { collected, done } = await f.start();
		f.line({ type: 'session', sessionId: 'session-1', cwd: f.dir });
		f.line({ type: 'text', text: 'cut…', truncated: true });
		f.line({ type: 'final', text: 'cut…restored-full-answer' });
		f.line({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } });
		f.groupExit(); f.close(0);
		await done;
		expect(collected.map((e) => e.type)).toEqual(['thinking', 'thinking', 'done']);
		expect(collected[0]).toEqual({ type: 'thinking', text: 'cut……[truncated]' });
		expect(collected[1]).toEqual({ type: 'thinking', text: 'cut…restored-full-answer' });
	});

	it('resumes the bound session with DSH_SESSION_ID and rejects prompt/workspace drift (#424)', async () => {
		const f = fixture();
		f.input.conversation.nativeState = { version: 1, value: { sessionId: 'historical-id',
			workspace: f.dir, promptHash: promptHash('system instructions') } };
		const { collected, done } = await f.start();
		expect(f.spawnCalls[0].args).toEqual(['--profile', 'headless', '--json', '--session-id', 'historical-id', '-']);
		expect(f.spawnCalls[0].options.env.DSH_SESSION_ID).toBe('historical-id');
		f.line({ type: 'session', sessionId: 'historical-id', cwd: f.dir });
		f.line({ type: 'final', text: 'again' });
		f.line({ type: 'status', phase: 'turn_end', turn: 2, reason: { kind: 'completed' } });
		f.groupExit(); f.close(0);
		await done;
		expect(collected.map((e) => e.type)).toEqual(['thinking', 'done']);

		const drift = fixture();
		drift.input.conversation.nativeState = { version: 1, value: { sessionId: 'historical-id',
			workspace: drift.dir, promptHash: 'other-hash' } };
		const run = drift.driver.createRun(drift.input);
		await expect((async () => { for await (const _ of run.events); })()).rejects
			.toThrow('explicit reset required');
	});

	it('an error line never terminates the run by itself; verdict comes from exit + turn_end', async () => {
		const f = fixture();
		const { collected, done } = await f.start();
		f.line({ type: 'session', sessionId: 'session-1', cwd: f.dir });
		f.line({ type: 'error', message: 'tool wobbled but recovered' });
		f.line({ type: 'text', text: 'still fine' });
		f.line({ type: 'final', text: 'still fine' });
		f.line({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } });
		f.groupExit(); f.close(0);
		await done;
		expect(collected.map((e) => e.type)).toEqual(['thinking', 'done']);
	});

	it('fails honestly on nonzero exit and on missing turn_end (never claims stopped)', async () => {
		const f = fixture();
		const first = await f.start();
		f.line({ type: 'session', sessionId: 'session-1', cwd: f.dir });
		f.line({ type: 'status', phase: 'turn_end', turn: 1,
			reason: { kind: 'error', error: { code: 'E_MODEL', message: 'overloaded' } } });
		f.groupExit(); f.close(1);
		await first.done;
		expect(first.collected[first.collected.length - 1]).toEqual(
			expect.objectContaining({ type: 'error', message: expect.stringContaining('dsh exited 1') }));

		const g = fixture();
		const second = await g.start();
		g.line({ type: 'session', sessionId: 'session-2', cwd: g.dir });
		g.line({ type: 'text', text: 'partial' });
		g.groupExit(); g.close(0);
		await second.done;
		expect(second.collected[second.collected.length - 1]).toEqual(
			expect.objectContaining({ type: 'error', message: 'UNEXPECTED_EOF' }));
	});

	it('rejects invalid prepared runs', () => {
		const f = fixture();
		expect(() => f.driver.createRun({ ...f.input, workspace: undefined })).toThrow('Invalid DSH prepared run');
		expect(() => f.driver.createRun({ ...f.input, contextKey: undefined })).toThrow('Invalid DSH prepared run');
		expect(() => f.driver.createRun({ ...f.input, replyToken: undefined })).toThrow('Invalid DSH prepared run');
	});
});
