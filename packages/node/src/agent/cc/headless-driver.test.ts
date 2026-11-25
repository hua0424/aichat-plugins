import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CcHeadlessDriver, type CcChild, type CcHeadlessDriverDeps, type CcSpawnOptions } from './headless-driver.js';
import { DriverDisconnectIncompleteError, type AgentEvent, type CapabilityExecution, type PreparedRun } from '../events.js';
import { CcSessionRegistry } from './sink.js';
import { AgentCommandHandler } from '../../handler/agent-command.js';
import * as preflight from './native-compact-preflight.js';
import * as compact from './compact.js';

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
	const spawnCalls: Array<{ command: string; args: readonly string[]; options: CcSpawnOptions }> = [];
	const transcript = vi.fn();
	const driver = new CcHeadlessDriver({ workspaceBase: dir, brokerPort: 9100,
		registerHook: (key, id, push) => registry.registerContext(key, id, push),
		transcript: { append: transcript },
		spawn: (command, args, options) => { spawnCalls.push({ command, args, options }); return child; },
		kill, platform: 'linux', firstEventTimeoutMs: 500, stopTimeoutMs: 180, killGraceMs: 10, drainMs: 0,
		...overrides });
	const persisted: Array<unknown> = [];
	const controller = new AbortController();
	const input: PreparedRun = { runId: 'core-run', message: '[HuLa 群聊]\nAlice(1): hi',
		workspace: dir, transcriptKey: 'aiclaw-5-room-9', contextKey: 'opaque-new-key', bindToken: 'opaque-legacy-alias',
		replyToken: 'f'.repeat(64),
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
		persisted, registry, transcript, kill, endInput: child.stdin!.end,
		groupExit: () => { groupAlive = false; }, close: (code: number | null) => { process.emit('close', code, null); },
		line: (value: object) => output.emit('data', `${JSON.stringify(value)}\n`) };
}

// POSIX group probes need the native -pgid API; on Windows this driver deliberately cannot confirm stop.
const posix = it;

describe('CC native capability observation', () => {
	posix('offers observed native skills for typed receipt after the ordinary child settles, without starting another turn', async () => {
		const f = fixture();
		const sessionId = 'f30ea438-e7d9-431c-a9a9-0f3d2ec18ebc';
		const prepareNative = vi.spyOn(preflight, 'prepareCcNativeCompact').mockResolvedValue(undefined);
		try {
			const { done } = await f.start();
			await vi.waitFor(() => expect(f.writes).toHaveLength(1));
			f.line({ type: 'system', subtype: 'init', session_id: sessionId, cwd: f.dir, claude_code_version: '2.1.195',
				slash_commands: ['ordinary', 'project:example'], skills: ['project:example'] });
			f.line({ type: 'result', session_id: sessionId, is_error: false });
			f.groupExit(); f.close(0);
			await done;
			const conversation = { ...f.input.conversation, get nativeState() {
				return f.persisted.at(-1) as PreparedRun['conversation']['nativeState'];
			} };
			const emit = vi.fn<CapabilityExecution['emit']>().mockResolvedValue(undefined);
			const execution = { requestId: 'skill', conversation, systemPrompt: '', contextKey: 'opaque', promptOwner: 'agent',
				authorizationEpoch: 'epoch', saveRecovery: vi.fn(), submitted: vi.fn(), selectModel: vi.fn(), replaceSession: vi.fn(), emit, bindTurn: vi.fn() };
			const handler = new AgentCommandHandler(f.driver, 'agent', f.dir, { prepare: async () => ({ execution }), conversation: () => conversation });
			const scope = { roomId: 'room', aiclawUid: 'agent', context: { roomType: 2, counterpartUid: 'owner', isOwner: true, workspaceDir: f.dir, authorizationEpoch: 'epoch' } };
			const discovery = handler.handle({ ...scope, requestId: 'discover-skill', operation: 'discover' });
			await vi.waitFor(() => expect(f.writes).toHaveLength(2));
			f.line({ type: 'control_response', response: { request_id: JSON.parse(f.writes[1]).request_id, subtype: 'success',
				response: { models: [{ value: 'native', displayName: 'Native model' }] } } });
			f.close(0);
			const catalog = (await discovery)?.catalog;
			expect(catalog?.capabilities).toEqual([
				expect.objectContaining({ id: 'model.list' }),
				expect.objectContaining({ id: 'skill:project:example', source: 'skill', kind: 'skill', supported: true,
					executable: false, reason: 'submission_only', defaultVisibility: 'public' }),
			]);
			const invoke = { ...scope, requestId: 'skill', operation: 'invoke', capabilityId: 'skill:project:example',
				catalogVersion: catalog!.version, parameters: { arguments: '  original\narguments  ' } };
			const result = await handler.handle(invoke);
			expect(result).toEqual({ requestId: 'skill', roomId: 'room', status: 'noop', phase: 'outcome', text: '插件已收到技能指令，未执行。' });
			expect(emit.mock.calls).toEqual([[{ type: 'receipt', receipt: { status: 'noop', phase: 'outcome', text: '插件已收到技能指令，未执行。' } }]]);
			expect(await handler.handle({ ...invoke, requestId: 'unknown-skill', capabilityId: 'skill:ordinary' })).toMatchObject({ status: 'failed', error: 'catalog_stale' });
			expect(await handler.handle({ ...invoke, requestId: 'wrong-version', catalogVersion: 'cc-models:previous' })).toMatchObject({ status: 'failed', error: 'catalog_stale' });
			expect(execution.bindTurn).not.toHaveBeenCalled();
			expect(execution.submitted).not.toHaveBeenCalled();
			expect(f.spawnCalls).toHaveLength(2);
			expect(f.writes).toHaveLength(2);
		} finally { prepareNative.mockRestore(); }
	});
	posix('executes the discovered compact once with the original idle session and returns its verified effect', async () => {
		const f = fixture();
		const sessionId = 'f30ea438-e7d9-431c-a9a9-0f3d2ec18ebc';
		const controlId = 'a2a059dd-ef7a-4120-864b-a3d7f3d99aa4';
		const summaryId = '4ec5d7fe-0a1b-4260-9f6e-d02054d84698';
		const conversation = { ...f.input.conversation, nativeState: { version: 1, value: { sessionId, workspace: f.dir,
			skillObservation: { runtimeVersion: '2.1.195', names: ['project:example'] } } } };
		const path = join(f.dir, `${sessionId}.jsonl`), originalBytes = Buffer.from('original\n');
		writeFileSync(path, originalBytes);
		const handles: Awaited<ReturnType<typeof open>>[] = [];
		const assertIntact = vi.fn<preflight.CcNativeCompactPreflight['assertIntact']>().mockResolvedValue(undefined);
		const prepareNative = vi.spyOn(preflight, 'prepareCcNativeCompact').mockImplementation(async () => {
			const handle = await open(path, 'r');
			handles.push(handle);
			return { cwd: f.dir, cliPath: '/owned/claude', settingsPath: '/owned/settings.json', env: {},
				assertIntact, history: { path, handle, originalBytes } };
		});
		const release = vi.fn();
		const reserve = vi.fn(() => release);
		const observe = vi.spyOn(compact, 'observeCcCompact').mockImplementation(async ({ inputId, assertCurrent, beforeInput, onSubmit, onAccepted }) => {
			expect(reserve).toHaveBeenCalledWith(sessionId, inputId);
			expect(assertIntact).toHaveBeenLastCalledWith();
			await beforeInput!();
			expect(assertIntact).toHaveBeenLastCalledWith('native-resume');
			assertCurrent();
			onSubmit!();
			onAccepted?.();
			return { controlId, summaryId, summaryHash: 'native', preTokens: 1570, postTokens: 1213 };
		});
		const verify = vi.spyOn(compact, 'verifyCcCompactAppend').mockResolvedValue({ status: 'completed', controlId, summaryId });
		const execute = { requestId: 'compact', conversation, systemPrompt: '', contextKey: 'opaque', promptOwner: 'agent',
			authorizationEpoch: 'epoch', reserveCcCompact: reserve, saveRecovery: vi.fn(), submitted: vi.fn(), selectModel: vi.fn(),
			replaceSession: vi.fn(), emit: vi.fn<CapabilityExecution['emit']>().mockResolvedValue(undefined), bindTurn: vi.fn() };
		const scope = { roomId: 'room', aiclawUid: 'agent', context: { roomType: 2, counterpartUid: 'owner', isOwner: true, workspaceDir: f.dir, authorizationEpoch: 'epoch' } };
		const handler = new AgentCommandHandler(f.driver, 'agent', f.dir, { prepare: async () => ({ execution: execute }), conversation: () => conversation });
		try {
			async function nativeInventory(index: number, value = 'native') {
				await vi.waitFor(() => expect(f.writes).toHaveLength(index + 1));
				f.line({ type: 'control_response', response: { request_id: JSON.parse(f.writes[index]).request_id, subtype: 'success',
					response: { models: [{ value, displayName: 'Native model' }] } } });
				await vi.waitFor(() => expect(f.endInput).toHaveBeenCalledTimes(index + 1));
				f.groupExit(); f.close(0);
			}
			const discovery = handler.handle({ ...scope, requestId: 'discover', operation: 'discover' });
			await nativeInventory(0);
			const catalog = (await discovery)?.catalog;
			expect(catalog?.capabilities).toContainEqual(expect.objectContaining({ id: 'session.compact', executable: true }));
			expect(catalog?.capabilities).toContainEqual(expect.objectContaining({ id: 'skill:project:example', executable: false }));
			const invoke = { ...scope, requestId: 'compact', operation: 'invoke', capabilityId: 'session.compact', catalogVersion: catalog!.version };
			const list = handler.handle({ ...invoke, requestId: 'list', capabilityId: 'model.list' });
			await nativeInventory(1);
			expect(await list).toMatchObject({ status: 'completed', text: expect.stringContaining('Native model') });
			const stale = handler.handle({ ...invoke, requestId: 'stale' });
			await nativeInventory(2, 'different inventory');
			expect(await stale).toMatchObject({ status: 'failed', error: 'catalog_stale' });
			expect(reserve).not.toHaveBeenCalled();
			execute.emit.mockRejectedValueOnce(new Error('admission publication unavailable'));
			const original = handler.handle(invoke), duplicate = handler.handle(invoke);
			await nativeInventory(3);
			const result = await original;
			expect(result).toMatchObject({ requestId: 'compact', status: 'completed', generation: '1', nativeRef: { sessionId },
				effect: { kind: 'compact', controlId, summaryId, summary: true } });
			expect(await duplicate).toEqual(result);
			expect(observe).toHaveBeenCalledOnce();
			expect(execute.emit.mock.calls.slice(-2)).toEqual([
				[{ type: 'receipt', receipt: { status: 'accepted', phase: 'accepted', generation: '1', nativeRef: { sessionId } } }],
				[{ type: 'receipt', receipt: expect.objectContaining({ status: 'completed', phase: 'outcome', nativeRef: { sessionId } }) }],
			]);
			expect(verify).toHaveBeenCalledOnce();
			expect(release).toHaveBeenCalledOnce();
			verify.mockRejectedValueOnce(new Error('no durable effect'));
			const uncertain = handler.handle({ ...invoke, requestId: 'unconfirmed-effect' });
			await nativeInventory(4);
			expect(await uncertain).toMatchObject({ status: 'unknown', nativeRef: { sessionId } });
			expect(release).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'unknown', nativeRef: { sessionId } }));
			expect(handles.map(handle => handle.fd)).toEqual([-1, -1, -1, -1, -1]);
			for (const [bin, args] of f.spawnCalls.map(call => [call.command, call.args] as const)) {
				expect(bin).toBe('/owned/claude');
				expect(args.slice(-2)).toEqual(['--settings', '/owned/settings.json']);
			}
			expect(execute.bindTurn).not.toHaveBeenCalled();
		} finally { prepareNative.mockRestore(); observe.mockRestore(); verify.mockRestore(); }
	});
	posix('does not advertise an ambient catalog when disconnect races a scoped inventory', async () => {
		const f = fixture();
		const sessionId = 'f30ea438-e7d9-431c-a9a9-0f3d2ec18ebc';
		const conversation = { ...f.input.conversation, nativeState: { version: 1, value: { sessionId, workspace: f.dir } } };
		const path = join(f.dir, `${sessionId}.jsonl`);
		writeFileSync(path, 'original\n');
		const handle = await open(path, 'r');
		const assertIntact = vi.fn().mockResolvedValueOnce(undefined).mockImplementationOnce(() => f.driver.disconnect());
		const prepare = vi.spyOn(preflight, 'prepareCcNativeCompact').mockResolvedValue({ cwd: f.dir,
			cliPath: '/owned/claude', settingsPath: '/owned/settings.json', env: {}, assertIntact,
			history: { path, handle, originalBytes: Buffer.from('original\n') } });
		try {
			const discovery = f.driver.discoverCapabilities({ roomId: 'room', workspace: f.dir, conversation, signal: f.controller.signal });
			await vi.waitFor(() => expect(f.writes).toHaveLength(1));
			f.line({ type: 'control_response', response: { request_id: JSON.parse(f.writes[0]).request_id, subtype: 'success',
				response: { models: [{ value: 'scoped', displayName: 'Scoped model' }] } } });
			f.groupExit(); f.close(0);
			expect(await discovery).toMatchObject({ capabilities: [], discovery: { coverage: 'unavailable' } });
			expect(assertIntact).toHaveBeenCalledTimes(2);
		} finally { prepare.mockRestore(); await handle.close(); }
	});
	posix('discovers and lists models from the idle native instance without sending user input', async () => {
		const f = fixture();
		const derived = join(f.dir, 'agent', 'owner');
		expect(existsSync(derived)).toBe(false);
		const prepare = vi.fn();
		const handler = new AgentCommandHandler(f.driver, 'agent', f.dir, { prepare });
		const scope = { roomId: 'room', aiclawUid: 'agent', context: { roomType: 2, counterpartUid: 'owner', isOwner: true } };
		async function reply(index: number, value: string) {
			await vi.waitFor(() => expect(f.writes).toHaveLength(index + 1));
			const frame = JSON.parse(f.writes[index]);
			expect(frame).toMatchObject({ type: 'control_request', request: { subtype: 'initialize' } });
			f.line({ type: 'control_response', response: { request_id: frame.request_id, subtype: 'success',
				response: { models: [{ value, displayName: 'Native model' }] } } });
			await vi.waitFor(() => expect(f.endInput).toHaveBeenCalledTimes(index + 1));
			f.groupExit(); f.close(0);
		}
		const discovery = handler.handle({ ...scope, requestId: 'discover', operation: 'discover' });
		await reply(0, 'provider-choice');
		const catalog = (await discovery)?.catalog;
		expect(f.spawnCalls[0].options.cwd).toBe(derived);
		expect(existsSync(derived)).toBe(true);
		expect(catalog?.capabilities).toEqual([expect.objectContaining({ id: 'model.list', executable: true, defaultVisibility: 'public', scope: 'instance' })]);
		const invoke = { ...scope, requestId: 'list', operation: 'invoke', capabilityId: 'model.list', catalogVersion: catalog!.version };
		const result = handler.handle(invoke);
		await reply(1, 'provider-choice');
		expect(await result).toMatchObject({ requestId: 'list', roomId: 'room', status: 'completed', text: expect.stringContaining('Native model — provider-choice') });
		expect(await handler.handle(invoke)).toEqual(await result);
		const changed = handler.handle({ ...invoke, requestId: 'list-new' });
		await reply(2, 'changed-model');
		expect(await changed).toEqual({ requestId: 'list-new', roomId: 'room', status: 'failed', error: 'catalog_stale' });
		expect(f.spawnCalls).toHaveLength(3);
		expect(prepare).not.toHaveBeenCalled();
		expect(f.transcript).not.toHaveBeenCalled();
	});
	posix('projects the actual init catalog only from the exact live conversation without submitting another input', async () => {
		const f = fixture();
		const { done } = await f.start();
		try {
			f.line({ type: 'system', subtype: 'init', session_id: 'native-session', cwd: f.dir,
				claude_code_version: '2.1.195', slash_commands: ['x'.repeat(121), 'x'.repeat(120), 'compact', 'example:hello'], skills: ['example:hello'] });
			const context = { conversation: f.input.conversation, workspace: f.dir, signal: f.input.signal };
			await vi.waitFor(async () => expect(await f.driver.discoverCapabilities(context)).toMatchObject({
				framework: 'cc', runtimeVersion: '2.1.195', discovery: { source: 'native', coverage: 'partial' },
				capabilities: [{ id: 'command:compact', executable: false, defaultVisibility: 'hidden' },
					{ id: 'command:example:hello', executable: false, defaultVisibility: 'hidden' },
					{ id: `command:${'x'.repeat(120)}`, executable: false, defaultVisibility: 'hidden' }],
			}));
			expect((await f.driver.discoverCapabilities({ ...context, conversation: { ...context.conversation, generation: 2 } })).capabilities).toEqual([]);
			expect((await f.driver.discoverCapabilities({ ...context, workspace: join(f.dir, 'other') })).capabilities).toEqual([]);
			expect((await f.driver.discoverCapabilities({ ...context, capabilityId: 'model.set' })).capabilities).toEqual([]);
			f.line({ type: 'system', subtype: 'commands_changed', session_id: 'native-session', commands: [] });
			await Promise.resolve(); // The waiting consumer has woken, but has not handled the frame yet.
			expect((await f.driver.discoverCapabilities(context)).discovery?.coverage).toBe('unavailable');
			expect(f.spawnCalls).toHaveLength(1);
			expect(f.writes).toHaveLength(1);
		} finally {
			f.line({ type: 'result', session_id: 'native-session', is_error: false });
			f.groupExit(); f.close(0);
			await done;
		}
		const idle = f.driver.discoverCapabilities({ conversation: f.input.conversation, workspace: f.dir, signal: f.input.signal });
		await vi.waitFor(() => expect(f.writes).toHaveLength(2));
		const request = JSON.parse(f.writes[1]);
		expect(request).toMatchObject({ type: 'control_request', request: { subtype: 'initialize' } });
		f.line({ type: 'control_response', response: { request_id: request.request_id, subtype: 'success',
			response: { models: [{ value: 'model-a', displayName: 'Model A' }] } } });
		f.close(0);
		expect((await idle).capabilities.map((capability) => capability.id)).toEqual(['model.list']);
	});
	posix('withholds the catalog while the consumer has not processed a received directory change', async () => {
		const f = fixture();
		const run = f.driver.createRun(f.input);
		const events = run.events[Symbol.asyncIterator]();
		const first = events.next();
		try {
			await vi.waitFor(() => expect(f.writes).toHaveLength(1));
			f.line({ type: 'system', subtype: 'init', session_id: 'native-session', cwd: f.dir,
				claude_code_version: '2.1.195', slash_commands: ['compact'], skills: [] });
			f.line({ type: 'assistant', session_id: 'native-session', message: { content: [{ type: 'text', text: 'thinking' }] } });
			expect((await first).value).toEqual({ type: 'thinking', text: 'thinking' });
			const context = { conversation: f.input.conversation, workspace: f.dir, signal: f.input.signal };
			expect((await f.driver.discoverCapabilities(context)).capabilities).toHaveLength(1);
			f.line({ type: 'system', subtype: 'commands_changed', session_id: 'native-session', commands: [] });
			expect((await f.driver.discoverCapabilities(context)).discovery?.coverage).toBe('unavailable');
		} finally {
			f.line({ type: 'result', session_id: 'native-session', is_error: false });
			f.groupExit(); f.close(0);
			await first;
			while (!(await events.next()).done) { /* drain the owned iterator */ }
		}
	});
});

describe('CC PreparedRun native execution', () => {
	posix('keeps stdin open through the native result without sending a second input or completing early', async () => {
		const f = fixture();
		const { collected, done } = await f.start();
		try {
			await vi.waitFor(() => expect(f.writes).toHaveLength(1));
			f.line({ type: 'system', subtype: 'init', session_id: 'native-session' });
			f.line({ type: 'assistant', session_id: 'native-session', message: { content: [{ type: 'text', text: 'reply' }] } });
			await vi.waitFor(() => expect(collected).toEqual([{ type: 'thinking', text: 'reply' }]));
			expect(f.endInput).not.toHaveBeenCalled();
			f.line({ type: 'result', session_id: 'native-session', is_error: false });
			f.line({ type: 'result', session_id: 'native-session', is_error: false });
			await vi.waitFor(() => expect(f.endInput).toHaveBeenCalledTimes(1));
			expect(f.writes).toHaveLength(1);
			expect(collected.map((event) => event.type)).toEqual(['thinking']);
		} finally {
			f.groupExit(); f.close(0);
			await done;
		}
		expect(collected.map((event) => event.type)).toEqual(['thinking', 'done']);
	});

	posix.each([
		{ init: false, resultSession: 'foreign' },
		{ init: true, resultSession: undefined },
	])('does not close stdin or report success without matching result identity ($init, $resultSession)', async ({ init, resultSession }) => {
		const f = fixture();
		const { collected, done } = await f.start();
		try {
			await vi.waitFor(() => expect(f.writes).toHaveLength(1));
			if (init) f.line({ type: 'system', subtype: 'init', session_id: 'native-session' });
			f.line({ type: 'result', session_id: resultSession, is_error: false });
			await vi.waitFor(() => expect(f.kill).toHaveBeenCalledWith(-4242, 'SIGTERM'));
			expect(f.endInput).not.toHaveBeenCalled();
		} finally {
			f.groupExit(); f.close(0);
			await done;
		}
		expect(collected).toEqual([{ type: 'error', message: 'CC native result session unconfirmed' }]);
		expect(f.writes).toHaveLength(1);
	});

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
		// #404: exactly one frozen reply binding per run, inherited values never merged.
		expect(f.spawnCalls[0].options.env.AICHAT_RUN_BIND).toBe('f'.repeat(64));
		expect(f.spawnCalls[0].options.env.OPENCODE_SESSION_ID).toBeUndefined();
		const wire = JSON.parse(f.writes[0]);
		expect(f.transcript).toHaveBeenCalledWith('aiclaw-5-room-9', expect.objectContaining({ kind: 'inbound' }));
		f.line({ type: 'system', subtype: 'init', session_id: 'historical-id' });
		f.line({ type: 'assistant', session_id: 'historical-id', message: { content: [{ type: 'text', text: 'thinking' }] } });
		f.registry.pushContext('opaque-new-key', f.spawnCalls[0].options.env.AICHAT_CC_RUN!, { type: 'tool', name: 'Bash', phase: 'end' });
		f.line({ type: 'result', session_id: 'historical-id', is_error: false });
		await tick();
		expect(events.some((e) => e.type === 'done')).toBe(false); // result != child close
		f.groupExit(); f.close(0);
		await done;
		expect(events.map((e) => e.type)).toEqual(['thinking', 'tool', 'done']);
		expect(f.persisted).toEqual([{ version: 1, value: { sessionId: 'historical-id', workspace: f.dir } }]);
		expect(wire).toMatchObject({ type: 'user', uuid: expect.stringMatching(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/),
			session_id: 'historical-id', parent_tool_use_id: null,
			message: { role: 'user', content: [{ type: 'text', text: f.input.message }] } });
		expect(f.writes).toHaveLength(1);
		expect(vi.mocked(f.input.saveRecovery).mock.calls.map(([snapshot]) => snapshot.value)).toEqual([
			expect.objectContaining({ inputId: wire.uuid, sessionId: 'historical-id' }),
			expect.objectContaining({ inputId: wire.uuid, sessionId: 'historical-id', pid: 4242 }),
			expect.objectContaining({ inputId: wire.uuid, sessionId: 'historical-id', pid: 4242 }),
		]);
	});

	posix('overwrites an inherited AICHAT_RUN_BIND with the frozen per-run token', async () => {
		const f = fixture();
		const saved = process.env.AICHAT_RUN_BIND;
		process.env.AICHAT_RUN_BIND = '0'.repeat(64);
		try {
			const { done } = await f.start({ ...f.input, replyToken: 'a'.repeat(64) });
			expect(f.spawnCalls[0].options.env.AICHAT_RUN_BIND).toBe('a'.repeat(64));
			f.groupExit(); f.close(0);
			await done;
		} finally {
			if (saved === undefined) delete process.env.AICHAT_RUN_BIND;
			else process.env.AICHAT_RUN_BIND = saved;
		}
	});

	posix('does not finish on EOF or close while a descendant survives; cancel remains unconfirmed', async () => {		const f = fixture();
		const { run, collected, done } = await f.start();
		f.line({ type: 'system', subtype: 'init', session_id: 'native-session' });
		f.line({ type: 'result', session_id: 'native-session', is_error: false });
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

	posix('#382: pre-init resume exit with "No conversation found" is classified; post-init failures stay raw', async () => {
		// 现场验收 B 形状：ready 会话 --resume 后原生历史已丢，CLI 预热即退出。
		const lost = fixture();
		lost.input.conversation.nativeState = { version: 1, value: { sessionId: '99881409', workspace: lost.dir } };
		const { collected, done } = await lost.start();
		lost.errors.emit('data', 'No conversation found with session ID: 99881409');
		lost.groupExit(); lost.close(1);
		await done;
		expect(collected).toHaveLength(1);
		expect((collected[0] as { message: string }).message)
			.toMatch(/^native_session_lost: claude exited 1: .*No conversation found/);
		// 正常续会话不受影响：init 已见（resume 被接受）后的执行失败不误分类。
		const okay = fixture();
		okay.input.conversation.nativeState = { version: 1, value: { sessionId: 'healthy', workspace: okay.dir } };
		const { collected: okayEvents, done: okayDone } = await okay.start();
		okay.line({ type: 'system', subtype: 'init', session_id: 'healthy' });
		okay.line({ type: 'result', session_id: 'healthy', is_error: true, errors: ['boom after resume'] });
		okay.groupExit(); okay.close(1);
		await okayDone;
		const okayError = okayEvents.find((e) => e.type === 'error') as { message: string } | undefined;
		expect((okayError?.message ?? '').startsWith('native_session_lost:')).toBe(false);
	});

	posix('does not rebind the chat when a resumed CC invocation reports a different native session', async () => {
		const f = fixture();
		f.input.conversation.nativeState = { version: 1, value: { sessionId: 'original', workspace: f.dir } };
		const { collected, done } = await f.start();
		f.line({ type: 'system', subtype: 'init', session_id: 'unexpected' });
		f.line({ type: 'assistant', message: { content: [{ type: 'text', text: 'wrong session' }] } });
		f.line({ type: 'system', subtype: 'init', session_id: 'native-session' });
		f.line({ type: 'result', session_id: 'native-session', is_error: false });
		f.groupExit(); f.close(0);
		await done;
		expect(collected).toEqual([{ type: 'error', message: 'CC native session changed unexpectedly' }]);
		expect(f.persisted).toEqual([]);
		expect(f.input.saveRecovery).not.toHaveBeenCalledWith(expect.objectContaining({
			value: expect.objectContaining({ sessionId: 'unexpected' }),
		}));
		expect(f.spawnCalls).toHaveLength(1);
		expect(f.writes).toHaveLength(1);
	});

	posix.each([
		{ type: 'assistant', session_id: 'other', message: { content: [{ type: 'text', text: 'foreign text' }] } },
		{ type: 'result', session_id: 'other', is_error: false },
	])('rejects a $type from another session after matching init', async (foreign) => {
		const f = fixture();
		f.input.conversation.nativeState = { version: 1, value: { sessionId: 'original', workspace: f.dir } };
		const { collected, done } = await f.start();
		f.line({ type: 'system', subtype: 'init', session_id: 'original' });
		f.line(foreign);
		if (foreign.type === 'assistant') f.line({ type: 'result', session_id: 'original', is_error: false });
		f.groupExit(); f.close(0);
		await done;
		expect(collected).toEqual([{ type: 'error', message: 'CC native session changed unexpectedly' }]);
		expect(f.transcript).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: 'assistant' }));
		expect(f.persisted).toEqual([{ version: 1, value: { sessionId: 'original', workspace: f.dir } }]);
		expect(f.spawnCalls).toHaveLength(1);
		expect(f.writes).toHaveLength(1);
	});

	posix('reports incomplete disconnect until the original CC group has stopped', async () => {
		const f = fixture({ stopTimeoutMs: 40 });
		const { collected, done } = await f.start();
		try {
			f.close(0); // the child exited, but its process group still has a live member
			await expect(f.driver.disconnect()).rejects.toBeInstanceOf(DriverDisconnectIncompleteError);
			expect(collected).not.toContainEqual(expect.objectContaining({ type: 'done' }));
			f.groupExit();
			await expect(f.driver.disconnect()).resolves.toBeUndefined();
			expect(f.spawnCalls).toHaveLength(1);
		} finally {
			f.groupExit();
			await done;
		}
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

	posix('stops the original process without EOF or replay when aborted after init without a result', async () => {
		const f = fixture();
		const { collected, done } = await f.start();
		try {
			f.line({ type: 'system', subtype: 'init', session_id: 'native-session' });
			await vi.waitFor(() => expect(f.persisted).toHaveLength(1));
			f.controller.abort();
			await vi.waitFor(() => expect(f.kill).toHaveBeenCalledWith(-4242, 'SIGTERM'));
			expect(f.endInput).not.toHaveBeenCalled();
		} finally {
			f.groupExit(); f.close(null);
			await done;
		}
		expect(f.spawnCalls).toHaveLength(1);
		expect(f.writes).toHaveLength(1);
		expect(collected).not.toContainEqual(expect.objectContaining({ type: 'done' }));
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
		f.line({ type: 'system', subtype: 'init', session_id: 'native-session' });
		f.line({ type: 'assistant', session_id: 'native-session', message: { content: [{ type: 'tool_use', name: 'Bash', input: { script: 'x'.repeat(3000) } }] } });
		f.line({ type: 'result', session_id: 'native-session', is_error: false });
		f.line({ type: 'result', session_id: 'native-session', is_error: false });
		f.groupExit(); f.close(0);
		await done;
		expect(collected).toEqual([expect.objectContaining({ type: 'done' })]);
		const tool = f.transcript.mock.calls.find((call) => (call[1] as { kind?: string }).kind === 'tool_use');
		expect((tool?.[1] as { tool_input: string }).tool_input).toContain('…[truncated ');
	});

	posix('delivers a PostToolUse hook racing after child close before done', async () => {
		const f = fixture({ drainMs: 40 });
		const { collected, done } = await f.start();
		const attempt = f.spawnCalls[0].options.env.AICHAT_CC_RUN!;
		f.line({ type: 'system', subtype: 'init', session_id: 'native-session' });
		f.line({ type: 'result', session_id: 'native-session', is_error: false });
		f.groupExit(); f.close(0);
		await tick(); // the native stream closed, but the broker hook is still in flight
		f.registry.pushContext('opaque-new-key', attempt, { type: 'tool', name: 'Bash', phase: 'end' });
		await done;
		expect(collected.map((event) => event.type)).toEqual(['tool', 'done']);
	});

	posix('drops a late hook after completion without selecting a replacement run', async () => {
		const f = fixture();
		const { collected, done } = await f.start();
		const runId = f.spawnCalls[0].options.env.AICHAT_CC_RUN!;
		f.line({ type: 'system', subtype: 'init', session_id: 'native-session' });
		f.line({ type: 'result', session_id: 'native-session', is_error: false });
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
		f.line({ type: 'system', subtype: 'init', session_id: 'native-session' });
		f.line({ type: 'result', session_id: 'native-session', is_error: false });
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
