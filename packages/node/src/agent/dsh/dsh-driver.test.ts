import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DshHeadlessDriver, DSH_DRIFT_GATE_MESSAGE, DSH_EXPECTED_VERSION, isDshDriftGateError, type DshChild, type DshHeadlessDriverDeps, type DshSpawnOptions } from './dsh-driver.js';
import type { AgentEvent, PreparedRun } from '../events.js';
import { ConversationStore } from '../../capability/conversations.js';
import { resolveAgentContexts } from '../../commands/send-message.js';

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
	const aliased: Array<unknown> = [];
	const nativelyRegistered: Array<{ id: string; state: unknown }> = [];
	const recovered: Array<unknown> = [];
	const controller = new AbortController();
	const input: PreparedRun = { runId: 'core-run', message: '[HuLa 私聊]\nAlice(1): hi',
		workspace: dir, contextKey: 'opaque-new-key', replyToken: 'f'.repeat(64),
		systemPrompt: 'system instructions',
		conversation: { id: 'opaque-conversation', generation: 1, nativeState: undefined,
			assertCurrent: vi.fn(), saveNativeState: async (v) => { persisted.push(v); },
			registerNativeAlias: vi.fn(async (v) => { aliased.push(v); }),
			registerNative: vi.fn(async (id, state) => { nativelyRegistered.push({ id, state }); }) },
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
		persisted, aliased, nativelyRegistered, recovered, kill,
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
			expect(f.persisted).toEqual([]);
			// #421: session binds alias + state atomically (never state alone).
			expect(f.nativelyRegistered).toEqual([{ id: 'session-1', state: { version: 1, value: { sessionId: 'session-1',
				workspace: f.dir, promptHash: promptHash('system instructions') } } }]);
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
		// #421: the resumed id is re-announced before spawn, so a CLI send that
		// lands before the session event still resolves via byAlias.
		expect(f.input.conversation.registerNativeAlias).toHaveBeenCalledWith({ id: 'historical-id' });
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

	// #422: same-room multi-turn continuity, workspace-mismatch refusal, and
	// reset-then-fresh through the driver's own persisted shape (no new
	// production code — #421 already resumes via --session-id, rejects drift
	// pre-spawn, and never deletes native history; these lock the behavior).
	describe('#422 continue/reset', () => {
		it('continues the same session across turns through its own persisted state', async () => {
			const first = fixture();
			const turn1 = await first.start();
			first.line({ type: 'session', sessionId: 'session-continue', cwd: first.dir });
			first.line({ type: 'final', text: 'round one' });
			first.line({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } });
			first.groupExit(); first.close(0);
			await turn1.done;
			expect(turn1.collected.at(-1)).toEqual({ type: 'done', durationMs: expect.any(Number) });
			// Core persists exactly what registerNative stored; the next turn
			// resumes it verbatim — same session id on the wire and in env.
			const stored = first.nativelyRegistered[0].state as { version: number; value: unknown };
			const second = fixture();
			second.input.workspace = first.dir; // same room → same workspace
			second.input.conversation.nativeState = { version: 1, value: (stored as { value: unknown }).value };
			const turn2 = await second.start();
			expect(second.spawnCalls[0].args).toEqual(
				['--profile', 'headless', '--json', '--session-id', 'session-continue', '-']);
			expect(second.spawnCalls[0].options.env.DSH_SESSION_ID).toBe('session-continue');
			second.line({ type: 'session', sessionId: 'session-continue', cwd: first.dir });
			second.line({ type: 'final', text: 'round two' });
			second.line({ type: 'status', phase: 'turn_end', turn: 2, reason: { kind: 'completed' } });
			second.groupExit(); second.close(0);
			await turn2.done;
			expect(turn2.collected.at(-1)).toEqual({ type: 'done', durationMs: expect.any(Number) });
		});

		it('rejects workspace drift and malformed state without spawning', async () => {
			const moved = fixture();
			moved.input.conversation.nativeState = { version: 1, value: { sessionId: 'historical-id',
				workspace: '/some/other/dir', promptHash: promptHash('system instructions') } };
			const movedRun = moved.driver.createRun(moved.input);
			await expect((async () => { for await (const _ of movedRun.events); })()).rejects
				.toThrow('explicit reset required');
			expect(moved.spawnCalls.length).toBe(0);

			const malformed = fixture();
			malformed.input.conversation.nativeState = { version: 1, value: { workspace: malformed.dir } };
			const malformedRun = malformed.driver.createRun(malformed.input);
			await expect((async () => { for await (const _ of malformedRun.events); })()).rejects
				.toThrow('explicit reset required');
			expect(malformed.spawnCalls.length).toBe(0);
		});

		it('starts a fresh session after reset without re-announcing the old id', async () => {
			const before = fixture();
			const turn1 = await before.start();
			before.line({ type: 'session', sessionId: 'session-old', cwd: before.dir });
			before.line({ type: 'final', text: 'before reset' });
			before.line({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } });
			before.groupExit(); before.close(0);
			await turn1.done;
			// Core reset bumps the generation and clears nativeState/aliases; the
			// next run carries no session, so no --session-id and no stale Alias.
			// Old native history stays on dsh disk — the driver has no delete path.
			const after = fixture();
			const turn2 = await after.start();
			expect(after.spawnCalls[0].args).toEqual(['--profile', 'headless', '--json', '-']);
			expect(after.spawnCalls[0].options.env.DSH_SESSION_ID).toBeUndefined();
			expect(after.aliased.length).toBe(0);
			after.line({ type: 'session', sessionId: 'session-new', cwd: after.dir });
			after.line({ type: 'final', text: 'after reset' });
			after.line({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } });
			after.groupExit(); after.close(0);
			await turn2.done;
			expect(turn2.collected.at(-1)).toEqual({ type: 'done', durationMs: expect.any(Number) });
			expect(after.nativelyRegistered).toEqual([{ id: 'session-new', state: { version: 1, value: {
				sessionId: 'session-new', workspace: after.dir, promptHash: promptHash('system instructions') } } }]);
		});

		it('isDshDriftGateError classifies exactly the gate rejection for the handler notice', () => {
			expect(isDshDriftGateError(new Error(DSH_DRIFT_GATE_MESSAGE))).toBe(false); // Error object, not the message
			expect(isDshDriftGateError(DSH_DRIFT_GATE_MESSAGE)).toBe(true);
			expect(isDshDriftGateError('Codex native thread invalid or original cwd/prompt mismatch; explicit reset required (history retained)')).toBe(false);
			expect(isDshDriftGateError('')).toBe(false);
		});
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

	// #423: cancel is bounded (SIGTERM → SIGKILL → unconfirmed, never a false
	// stopped) and a surviving process group never reports done — core pauses
	// the session on the unconfirmed status; unpaired tool ends stay visible.
	describe('#423 cancel/failure honest reporting', () => {
		it('does not finish on close while a descendant survives; cancel stays unconfirmed', async () => {
			const f = fixture();
			const { run, collected, done } = await f.start();
			f.line({ type: 'session', sessionId: 'session-1', cwd: f.dir });
			f.line({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } });
			f.close(0); // group still alive: no groupExit()
			await done;
			expect(collected).toEqual([{ type: 'cancelled', reason: 'DSH stop unconfirmed' }]);
			expect(await run.cancel('probe')).toEqual(expect.objectContaining({ status: 'unconfirmed' }));
			expect(f.kill).toHaveBeenCalledWith(-4242, 'SIGTERM');
			expect(f.kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
		});

		it('confirms stop only on child close plus group exit, yielding honest cancelled', async () => {
			const f = fixture();
			const { run, collected, done } = await f.start();
			const stop = run.cancel('reset');
			f.groupExit();
			await tick();
			f.close(null);
			expect(await stop).toEqual({ status: 'stopped' });
			await done;
			expect(collected).toEqual([{ type: 'cancelled', reason: 'DSH cancelled' }]);
			expect(f.spawnCalls).toHaveLength(1);
		});

		it('first-event watchdog cannot turn a live process into a success', async () => {
			const f = fixture({ firstEventTimeoutMs: 5, stopTimeoutMs: 40, killGraceMs: 5 });
			const { collected, done } = await f.start();
			await done;
			expect(collected).toEqual([{ type: 'cancelled', reason: 'DSH stop unconfirmed' }]);
			expect(f.kill).toHaveBeenCalledWith(-4242, 'SIGTERM');
			expect(f.spawnCalls).toHaveLength(1);
		});

		it('keeps an unpaired tool end visible instead of dropping it', async () => {
			const f = fixture();
			const { collected, done } = await f.start();
			f.line({ type: 'session', sessionId: 'session-1', cwd: f.dir });
			f.line({ type: 'tool_result', status: 'completed', result: 'ok' });
			f.line({ type: 'final', text: 'answer' });
			f.line({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } });
			f.groupExit(); f.close(0);
			await done;
			expect(collected).toContainEqual({ type: 'tool', name: 'unknown', phase: 'end' });
			expect(collected.at(-1)).toEqual({ type: 'done', durationMs: expect.any(Number) });
		});
	});

	it('rejects invalid prepared runs', () => {
		const f = fixture();
		expect(() => f.driver.createRun({ ...f.input, workspace: undefined })).toThrow('Invalid DSH prepared run');
		expect(() => f.driver.createRun({ ...f.input, contextKey: undefined })).toThrow('Invalid DSH prepared run');
		expect(() => f.driver.createRun({ ...f.input, replyToken: undefined })).toThrow('Invalid DSH prepared run');
	});

	// #421 dead-lock proof against a REAL core store (not mocks): dsh core strips
	// AICHAT_CONTEXT_KEY from the tool env, so the CLI's only candidate is
	// {provider:'dsh',nativeId:<DSH_SESSION_ID>} — it must resolve byAlias to the
	// run's conversation, or every send-message ends in UNKNOWN_CONTEXT.
	describe('#421 DSH_SESSION_ID candidate resolves to the run conversation', () => {
		const uid = '217369059208704', room = '217369063403008';
		function liveHarness() {
			const dir = mkdtempSync(join(tmpdir(), 'dsh-alias-'));
			dirs.push(dir);
			const ws = join(dir, 'ws');
			const store = new ConversationStore({ home: dir, serverNamespace: 'http://example.test/api',
				activeUids: new Set([uid]), activeProviders: new Map([[uid, 'dsh']]) });
			const output = new EventEmitter();
			const errors = new EventEmitter();
			const proc = new EventEmitter();
			const writes: string[] = [];
			let groupAlive = true;
			const child = Object.assign(proc, {
				pid: 4242,
				stdin: { write: (s: string) => { writes.push(s); }, end: vi.fn() },
				stdout: output, stderr: errors, kill: vi.fn(() => true),
			}) as unknown as DshChild;
			const kill = (pid: number, signal?: NodeJS.Signals | number) => {
				if (pid !== -4242) throw new Error('wrong group');
				if (signal === 0 && !groupAlive) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
			};
			const spawnCalls: Array<{ cmd: string; args: readonly string[]; options: DshSpawnOptions }> = [];
			const driver = new DshHeadlessDriver({ spawn: (cmd, args, options) => {
				spawnCalls.push({ cmd, args, options });
				return child;
			}, kill, platform: 'linux', firstEventTimeoutMs: 500, stopTimeoutMs: 180, killGraceMs: 10 });
			// Wire exactly like MessageHandler: provider-narrowed nativeState + bound methods.
			const prepared = (runId: string, dshState: unknown) => {
				const bound = store.beginRun(uid, room, runId);
				const controller = new AbortController();
				const input: PreparedRun = { runId, message: 'hi', workspace: ws,
					contextKey: bound.contextKey, replyToken: bound.replyToken, systemPrompt: 'persona',
					conversation: { id: bound.conversationId, generation: bound.generation,
						...(dshState === undefined ? {} : { nativeState: { version: 1, value: dshState } }),
						assertCurrent: () => bound.assertCurrent(),
						saveNativeState: async (v) => bound.saveNativeState('dsh', v.value as Record<string, unknown>),
						registerNativeAlias: async (v) => bound.registerNativeAlias('dsh', v.id, v.scope),
						registerNative: async (id, state) => bound.registerNative('dsh', id, state.value as Record<string, unknown>) },
					saveRecovery: async (v) => bound.saveRecovery(v),
					capabilities: { invoke: vi.fn(async () => {}) }, signal: controller.signal };
				return { bound, input };
			};
			const line = (value: object) => output.emit('data', `${JSON.stringify(value)}\n`);
			return { dir, ws, store, driver, spawnCalls, output, proc, writes, prepared, line,
				finish: () => { groupAlive = false; proc.emit('close', 0, null); } };
		}

		it('first turn: CLI candidate resolves after the session event', async () => {
			const h = liveHarness();
			const { bound, input } = h.prepared('run-1', undefined);
			const run = h.driver.createRun(input);
			const collected: AgentEvent[] = [];
			const done = (async () => { for await (const event of run.events) collected.push(event); })();
			for (let i = 0; i < 30 && !h.spawnCalls.length; i++) await tick();
			expect(h.spawnCalls.length).toBe(1);
			h.line({ type: 'session', sessionId: 'session-7ca937ff', cwd: h.ws });
			for (let i = 0; i < 100 && !h.store.resolveCandidate({ provider: 'dsh', nativeId: 'session-7ca937ff' }); i++) await tick();
			// Exactly what the CLI posts when AICHAT_CONTEXT_KEY was stripped:
			const contexts = resolveAgentContexts({ DSH_SESSION_ID: 'session-7ca937ff' } as NodeJS.ProcessEnv);
			expect(contexts).toEqual([{ provider: 'dsh', nativeId: 'session-7ca937ff' }]);
			expect(h.store.resolveCandidates(contexts)?.conversationId).toBe(bound.conversationId);
			h.line({ type: 'final', text: 'reply' });
			h.line({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } });
			h.finish();
			await done;
			expect(collected[collected.length - 1]).toEqual({ type: 'done', durationMs: expect.any(Number) });
		});

		it('resume adopts a pre-fix core (state without alias): candidate resolves before spawn', async () => {
			const h = liveHarness();
			// Pre-fix shape: nativeState persisted, nativeAliases empty → unresolvable.
			const seed = h.store.beginRun(uid, room, 'run-0');
			const legacy = { sessionId: 'legacy-session', workspace: h.ws, promptHash: promptHash('persona') };
			seed.saveNativeState('dsh', legacy);
			h.store.finishRun('run-0');
			expect(h.store.resolveCandidate({ provider: 'dsh', nativeId: 'legacy-session' })).toBeUndefined();
			const { bound, input } = h.prepared('run-1', legacy);
			const run = h.driver.createRun(input);
			const collected: AgentEvent[] = [];
			const done = (async () => { for await (const event of run.events) collected.push(event); })();
			for (let i = 0; i < 30 && !h.spawnCalls.length; i++) await tick();
			expect(h.spawnCalls.length).toBe(1);
			// No session line emitted yet — the pre-spawn re-announce already fixed it.
			expect(h.store.resolveCandidates(
				resolveAgentContexts({ DSH_SESSION_ID: 'legacy-session' } as NodeJS.ProcessEnv),
			)?.conversationId).toBe(bound.conversationId);
			h.line({ type: 'session', sessionId: 'legacy-session', cwd: h.ws });
			h.line({ type: 'final', text: 'again' });
			h.line({ type: 'status', phase: 'turn_end', turn: 2, reason: { kind: 'completed' } });
			h.finish();
			await done;
			expect(collected[collected.length - 1]).toEqual({ type: 'done', durationMs: expect.any(Number) });
		});
	});
});
