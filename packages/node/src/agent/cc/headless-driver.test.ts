import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CcHeadlessDriver, parseCcBinding, type CcChild, type CcSpawnFn } from './headless-driver.js';
import type { CcTranscriptRecord } from './transcript.js';
import { CC_REPLY_CONTRACT } from './launch.js';
import { CcSessionRegistry, buildCcBridgeSink } from './sink.js';
import { CcBroker } from './broker.js';
import type { CcHeadlessSessionStore, StoredCcHeadlessSession } from './headless-session-store.js';
import type { AgentEvent } from '../events.js';
import { InMemoryBindTokenStore } from '../bind-token-store.js';

/** A deterministic bind-token store (tokens `tok-1`, `tok-2`, …) so AICHAT_BIND assertions are stable. */
function makeBindTokens(): InMemoryBindTokenStore {
	let n = 0;
	return new InMemoryBindTokenStore(() => `tok-${++n}`);
}

const tmpDirs: string[] = [];
function freshBase(): string {
	const d = mkdtempSync(join(tmpdir(), 'cc-headless-drv-'));
	tmpDirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of tmpDirs.splice(0)) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}
});

function memStore(): CcHeadlessSessionStore & { map: Map<string, StoredCcHeadlessSession> } {
	const map = new Map<string, StoredCcHeadlessSession>();
	return {
		map,
		get: (k) => map.get(k),
		set: (k, v) => {
			map.set(k, v);
		},
		delete: (k) => {
			map.delete(k);
		},
	};
}

/** A controllable fake child process + a spawn fn that returns it and records the spawn call. */
function fakeSpawn(pid = 4242) {
	const dataCbs: Array<(c: Buffer | string) => void> = [];
	const endCbs: Array<() => void> = [];
	const stderrCbs: Array<(c: Buffer | string) => void> = [];
	const errorCbs: Array<(e: Error) => void> = [];
	const exitCbs: Array<(code: number | null, signal: string | null) => void> = [];
	const stdinWrites: string[] = [];
	const stdinEnd = vi.fn();
	const kill = vi.fn(() => true);

	let spawnCall: { command: string; args: readonly string[]; options: Record<string, unknown> } | null = null;

	const child: CcChild = {
		pid,
		stdin: { write: (c: string) => void stdinWrites.push(c), end: () => stdinEnd() },
		stdout: {
			on: (event: string, listener: (...a: never[]) => void) => {
				if (event === 'data') dataCbs.push(listener as (c: Buffer | string) => void);
				if (event === 'end' || event === 'close') endCbs.push(listener as () => void);
			},
		} as CcChild['stdout'],
		stderr: {
			on: (event: string, listener: (...a: never[]) => void) => {
				if (event === 'data') stderrCbs.push(listener as (c: Buffer | string) => void);
			},
		} as CcChild['stderr'],
		on: (event: string, listener: (...a: never[]) => void) => {
			if (event === 'error') errorCbs.push(listener as (e: Error) => void);
			if (event === 'exit' || event === 'close') exitCbs.push(listener as (c: number | null, s: string | null) => void);
		},
		kill,
	};

	const spawn: CcSpawnFn = (command, args, options) => {
		spawnCall = { command, args, options: options as unknown as Record<string, unknown> };
		return child;
	};

	return {
		spawn,
		child,
		kill,
		stdinWrites,
		stdinEnd,
		get spawnCall() {
			return spawnCall;
		},
		emitStdout: (s: string) => dataCbs.forEach((cb) => cb(s)),
		emitStderr: (s: string) => stderrCbs.forEach((cb) => cb(s)),
		endStdout: () => endCbs.forEach((cb) => cb()),
		emitExit: (code: number | null) => exitCbs.forEach((cb) => cb(code, null)),
		emitError: (e: Error) => errorCbs.forEach((cb) => cb(e)),
	};
}

/**
 * A spawn fn that returns a FRESH fake child on EACH call and records per-call handles, so a single
 * turn that self-heals (spawns twice: dead `--resume` → fresh retry) can be driven per-attempt.
 */
function fakeMultiSpawn(basePid = 4242) {
	const calls: Array<{
		command: string;
		args: readonly string[];
		options: Record<string, unknown>;
		pid: number;
		child: CcChild;
		stdinWrites: string[];
		stdinEnd: ReturnType<typeof vi.fn>;
		kill: ReturnType<typeof vi.fn>;
		emitStdout: (s: string) => void;
		emitStderr: (s: string) => void;
		endStdout: () => void;
		emitExit: (code: number | null) => void;
		emitError: (e: Error) => void;
	}> = [];

	const spawn: CcSpawnFn = (command, args, options) => {
		const pid = basePid + calls.length;
		const dataCbs: Array<(c: Buffer | string) => void> = [];
		const endCbs: Array<() => void> = [];
		const stderrCbs: Array<(c: Buffer | string) => void> = [];
		const errorCbs: Array<(e: Error) => void> = [];
		const exitCbs: Array<(code: number | null, signal: string | null) => void> = [];
		const stdinWrites: string[] = [];
		const stdinEnd = vi.fn();
		const kill = vi.fn(() => true);
		const child: CcChild = {
			pid,
			stdin: { write: (c: string) => void stdinWrites.push(c), end: () => stdinEnd() },
			stdout: {
				on: (event: string, listener: (...a: never[]) => void) => {
					if (event === 'data') dataCbs.push(listener as (c: Buffer | string) => void);
					if (event === 'end' || event === 'close') endCbs.push(listener as () => void);
				},
			} as CcChild['stdout'],
			stderr: {
				on: (event: string, listener: (...a: never[]) => void) => {
					if (event === 'data') stderrCbs.push(listener as (c: Buffer | string) => void);
				},
			} as CcChild['stderr'],
			on: (event: string, listener: (...a: never[]) => void) => {
				if (event === 'error') errorCbs.push(listener as (e: Error) => void);
				if (event === 'exit' || event === 'close') exitCbs.push(listener as (c: number | null, s: string | null) => void);
			},
			kill,
		};
		calls.push({
			command,
			args,
			options: options as unknown as Record<string, unknown>,
			pid,
			child,
			stdinWrites,
			stdinEnd,
			kill,
			emitStdout: (s) => dataCbs.forEach((cb) => cb(s)),
			emitStderr: (s) => stderrCbs.forEach((cb) => cb(s)),
			endStdout: () => endCbs.forEach((cb) => cb()),
			emitExit: (code) => exitCbs.forEach((cb) => cb(code, null)),
			emitError: (e) => errorCbs.forEach((cb) => cb(e)),
		});
		return child;
	};
	return { spawn, calls };
}

async function drain(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
	const out: AgentEvent[] = [];
	for await (const ev of stream) out.push(ev);
	return out;
}

const BASE_CTX = { roomType: 1, roomId: '9' };
const KEY = 'aiclaw-5-room-9';

/** A fake CcTranscriptWriter that records every appended (key, record) pair. */
function fakeTranscript() {
	const records: Array<{ key: string; record: CcTranscriptRecord }> = [];
	return {
		records,
		append(key: string, record: CcTranscriptRecord) {
			records.push({ key, record });
		},
	};
}

function makeDriver(overrides: Partial<Parameters<typeof CcHeadlessDriver.prototype.constructor>[0]> = {}) {
	const fs = fakeSpawn();
	const registry = new CcSessionRegistry();
	const store = memStore();
	const bindTokens = makeBindTokens();
	const kill = vi.fn();
	const transcript = fakeTranscript();
	const driver = new CcHeadlessDriver({
		claudeBin: '/opt/claude',
		workspaceBase: freshBase(),
		brokerPort: 9100,
		sessionStore: store,
		bindTokens,
		registry,
		transcript,
		spawn: fs.spawn,
		kill,
		firstEventTimeoutMs: 1000,
		drainMs: 10,
		killGraceMs: 50,
		...overrides,
	});
	return { driver, fs, registry, store, bindTokens, kill, transcript };
}

/** Read the text of the stdin user envelope this fake spawn received. */
function stdinText(fs: ReturnType<typeof fakeSpawn>): string {
	return JSON.parse(fs.stdinWrites[0].trim()).message.content[0].text as string;
}

describe('CcHeadlessDriver — shape', () => {
	it('type=cc, drivesTurns=true (node drives cc turns now)', () => {
		const { driver } = makeDriver();
		expect(driver.type).toBe('cc');
		expect(driver.drivesTurns).toBe(true);
	});

	it('resolveSession is an opaque-token STORE LOOKUP (BL-014 #141), not a plaintext parse', async () => {
		const { driver, bindTokens } = makeDriver();
		// mint via openSession; the minted token round-trips, a forged plaintext binding does NOT.
		await driver.openSession({ aiclawUid: '7', roomId: '8', chatContext: BASE_CTX });
		const token = bindTokens.mint('7', '8'); // stable → the same token openSession minted (tok-1)
		expect(driver.resolveSession(token)).toEqual({ aiclawUid: '7', roomId: '8' });
		// anti-forgery: a guessed plaintext binding an agent could set in AICHAT_BIND does NOT resolve.
		expect(driver.resolveSession('aiclaw-7-room-8')).toBeUndefined();
		expect(driver.resolveSession('garbage')).toBeUndefined();
	});

	it('connect/disconnect resolve; openSession returns a session', async () => {
		const { driver } = makeDriver();
		await expect(driver.connect()).resolves.toBeUndefined();
		const s = await driver.openSession({ aiclawUid: '5', roomId: '9', chatContext: BASE_CTX });
		expect(typeof s.send).toBe('function');
		await expect(driver.disconnect()).resolves.toBeUndefined();
	});

	// aichatoverview#124: runtime per-room session reset — drop the stored session_id so the NEXT turn
	// spawns fresh (no --resume). Returns true (cc is stateful per-room). Other rooms unaffected.
	it('resetSession drops the stored session_id for (uid,room), returns true, other rooms unaffected', () => {
		const { driver, store } = makeDriver();
		store.set('aiclaw-1-room-2', { sessionId: 'sess_a' });
		store.set('aiclaw-1-room-3', { sessionId: 'sess_b' });
		expect(driver.resetSession('1', '2')).toBe(true);
		expect(store.get('aiclaw-1-room-2')).toBeUndefined();
		expect(store.get('aiclaw-1-room-3')).toEqual({ sessionId: 'sess_b' });
	});
});

describe('CcHeadlessSession.send — spawn argv/env/stdin', () => {
	it('spawns claude with the exact headless argv, cc env, and writes the given envelope to stdin verbatim', async () => {
		const { driver, fs } = makeDriver();
		// #132: chatContext carries this aiclaw's own display name → threaded into the system-prompt anchor.
		const session = await driver.openSession({
			aiclawUid: '5',
			roomId: '9',
			chatContext: { roomType: 2, roomId: '9', selfName: 'CCTestAI' },
		});
		// REQ-013 S1: the message arriving at send() is ALREADY the unified attribution envelope (built at
		// the handler common layer). The driver forwards it verbatim — no per-driver envelope building.
		session.send('[HuLa 私聊]\n[小明(100)]: 原始用户消息');

		const call = fs.spawnCall!;
		expect(call.command).toBe('/opt/claude');
		expect(call.args).toEqual([
			'-p',
			'--input-format',
			'stream-json',
			'--output-format',
			'stream-json',
			'--verbose',
			'--include-partial-messages',
			'--allowedTools',
			'Bash(aichat:*)',
			'--settings',
			expect.stringContaining('settings.json'),
			'--append-system-prompt',
			// #132: identity anchor (self name + uid) prefixed to the #102 reply contract body.
			expect.stringContaining('CCTestAI'),
		]);
		// no stored session → no --resume
		expect(call.args).not.toContain('--resume');
		// #132: the --append-system-prompt value carries BOTH the self display name and this aiclaw's uid,
		// AND the full #102 reply contract body (delivered at the SYSTEM level, once per turn).
		const systemPrompt = call.args[call.args.indexOf('--append-system-prompt') + 1];
		expect(systemPrompt).toContain('CCTestAI');
		expect(systemPrompt).toContain('5'); // aiclaw uid
		expect(systemPrompt).toContain(CC_REPLY_CONTRACT);
		expect(systemPrompt).toContain('aichat send-message');

		const env = call.options.env as NodeJS.ProcessEnv;
		// BL-014 (#141): AICHAT_BIND is the OPAQUE minted token (tok-1), NOT the guessable plaintext binding.
		expect(env.AICHAT_BIND).toBe('tok-1');
		expect(env.AICHAT_BIND).not.toBe('aiclaw-5-room-9');
		expect(env.CLAUDE_NON_INTERACTIVE).toBe('1');
		expect(call.options.detached).toBe(true);
		expect(call.options.stdio).toEqual(['pipe', 'pipe', 'pipe']);

		// stdin envelope: ONE stream-json user message = the ATTRIBUTED chat transcript (the #102 contract
		// lives in --append-system-prompt, not prepended here — no per-message content pollution). REQ-011
		// S3: cc anti-injection needs the current message attributed per-sender → DM = `[HuLa 私聊]\n[name(uid)]: msg`.
		expect(fs.stdinWrites.length).toBe(1);
		const env2 = JSON.parse(fs.stdinWrites[0].trim());
		expect(env2.type).toBe('user');
		const text = env2.message.content[0].text as string;
		expect(text).toBe('[HuLa 私聊]\n[小明(100)]: 原始用户消息');
		expect(text).not.toContain('aichat send-message'); // contract is NOT in the user message
		expect(fs.stdinEnd).toHaveBeenCalledOnce();
	});
});

describe('CcHeadlessSession.send — stdout control-plane', () => {
	it('#120: system:init → session_id stored; assistant text → {thinking} (panel); result → {done}', async () => {
		const { driver, fs, store } = makeDriver();
		const session = await driver.openSession({ aiclawUid: '5', roomId: '9', chatContext: BASE_CTX });
		const stream = session.send('hi');

		fs.emitStdout(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-abc' })}\n`);
		// #120: an assistant/text stdout block is teed to the thinking PANEL as a {thinking} event (display
		// only). The REPLY still comes from the CLI capability — no reply is parsed from stdout.
		fs.emitStdout(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello world' }] } })}\n`);
		fs.emitStdout(`${JSON.stringify({ type: 'result', subtype: 'success', session_id: 'sid-abc' })}\n`);

		const events = await drain(stream);
		expect(store.map.get(KEY)?.sessionId).toBe('sid-abc');
		expect(events).toContainEqual({ type: 'thinking', text: 'hello world' });
		expect(events[events.length - 1]).toEqual({ type: 'done', durationMs: expect.any(Number) });
	});

	it('EOF (stdout end) with no `result` still finishes as a backstop', async () => {
		const { driver, fs } = makeDriver();
		const session = await driver.openSession({ aiclawUid: '5', roomId: '9', chatContext: BASE_CTX });
		const stream = session.send('hi');
		fs.emitStdout(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-x' })}\n`);
		fs.endStdout();
		const events = await drain(stream);
		expect(events).toEqual([{ type: 'done', durationMs: expect.any(Number) }]);
	});

	it('tolerates a `data:` SSE-style prefix on stdout lines', async () => {
		const { driver, fs, store } = makeDriver();
		const session = await driver.openSession({ aiclawUid: '5', roomId: '9', chatContext: BASE_CTX });
		const stream = session.send('hi');
		fs.emitStdout(`data: ${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-sse' })}\n`);
		fs.emitStdout(`data: ${JSON.stringify({ type: 'result' })}\n`);
		await drain(stream);
		expect(store.map.get(KEY)?.sessionId).toBe('sid-sse');
	});
});

// ─── #120: stdout assistant text/thinking blocks feed the thinking PANEL (display only) ───
// The bug: the CC panel (im_aiclaw_thinking.content) was always empty because it was fed ONLY by the
// broker's MessageDisplay hook, whose payload carries text in `delta` not `content`. Fix (option B):
// tee the stdout assistant `text`/`thinking` blocks — the same data that fills the transcript — as
// {thinking} events so reduceThinking concatenates them into the panel. `tool_use` stays off this path.

describe('CcHeadlessSession.send — #120 stdout → thinking panel', () => {
	it('assistant text + thinking blocks → {thinking} events (panel) AND transcript records', async () => {
		const { driver, fs, transcript } = makeDriver();
		const session = await driver.openSession({ aiclawUid: '5', roomId: '9', chatContext: BASE_CTX });
		const stream = session.send('hi');

		fs.emitStdout(
			`${JSON.stringify({
				type: 'assistant',
				message: {
					content: [
						{ type: 'thinking', thinking: 'let me reason' },
						{ type: 'text', text: 'here is my narration' },
					],
				},
			})}\n`,
		);
		fs.emitStdout(`${JSON.stringify({ type: 'result' })}\n`);
		const events = await drain(stream);

		// panel: BOTH blocks pushed as {thinking} events (so reduceThinking concatenates them into content)
		expect(events).toContainEqual({ type: 'thinking', text: 'let me reason' });
		expect(events).toContainEqual({ type: 'thinking', text: 'here is my narration' });
		// the transcript still records them (the existing tee is unchanged)
		const recs = transcript.records.filter((r) => r.key === KEY).map((r) => r.record);
		expect(recs).toContainEqual(expect.objectContaining({ kind: 'thinking', text: 'let me reason' }));
		expect(recs).toContainEqual(expect.objectContaining({ kind: 'assistant', text: 'here is my narration' }));
	});

	it('a tool_use block emits NO {thinking} event (transcript only — tools stay on the hook path)', async () => {
		const { driver, fs, transcript } = makeDriver();
		const session = await driver.openSession({ aiclawUid: '5', roomId: '9', chatContext: BASE_CTX });
		const stream = session.send('hi');

		fs.emitStdout(
			`${JSON.stringify({
				type: 'assistant',
				message: { content: [{ type: 'tool_use', name: 'Bash', input: { cmd: 'ls' } }] },
			})}\n`,
		);
		fs.emitStdout(`${JSON.stringify({ type: 'result' })}\n`);
		const events = await drain(stream);

		expect(events.some((e) => e.type === 'thinking')).toBe(false); // a tool_use block pushes no thinking
		const recs = transcript.records.filter((r) => r.key === KEY).map((r) => r.record);
		expect(recs).toContainEqual(expect.objectContaining({ kind: 'tool_use', tool: 'Bash' }));
	});
});

describe('CcHeadlessSession.send — resume', () => {
	it('a stored session_id for (uid,room) → argv has --resume <sid>; a new init rebinds the store', async () => {
		const { driver, fs, store } = makeDriver();
		store.set(KEY, { sessionId: 'sid-prev' });
		const session = await driver.openSession({ aiclawUid: '5', roomId: '9', chatContext: BASE_CTX });
		const stream = session.send('hi');

		expect(fs.spawnCall!.args).toContain('--resume');
		expect(fs.spawnCall!.args[fs.spawnCall!.args.indexOf('--resume') + 1]).toBe('sid-prev');

		// the resumed turn reports a (possibly new) session_id → store follows it
		fs.emitStdout(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-next' })}\n`);
		fs.emitStdout(`${JSON.stringify({ type: 'result' })}\n`);
		await drain(stream);
		expect(store.map.get(KEY)?.sessionId).toBe('sid-next');
	});
});

describe('CcHeadlessSession.send — timeout & errors', () => {
	it('no stdout event within firstEventTimeoutMs → {error} + kills the process group', async () => {
		const { driver, fs, kill } = makeDriver({ firstEventTimeoutMs: 20, drainMs: 10 });
		const session = await driver.openSession({ aiclawUid: '5', roomId: '9', chatContext: BASE_CTX });
		const events = await drain(session.send('hi'));
		expect(events).toEqual([{ type: 'error', message: 'first-event timeout' }]);
		// killed the GROUP (negative pid), SIGTERM
		expect(kill).toHaveBeenCalledWith(-fs.child.pid!, 'SIGTERM');
	});

	it('nonzero exit before completion → {error} with the exit code', async () => {
		const { driver, fs } = makeDriver();
		const session = await driver.openSession({ aiclawUid: '5', roomId: '9', chatContext: BASE_CTX });
		const stream = session.send('hi');
		fs.emitStderr('boom on stderr');
		fs.emitExit(1);
		const events = await drain(stream);
		expect(events).toHaveLength(1);
		expect(events[0].type).toBe('error');
		expect((events[0] as { message: string }).message).toContain('claude exited 1');
		expect((events[0] as { message: string }).message).toContain('boom on stderr');
	});

	it('spawn error event → {error}', async () => {
		const { driver, fs } = makeDriver();
		const session = await driver.openSession({ aiclawUid: '5', roomId: '9', chatContext: BASE_CTX });
		const stream = session.send('hi');
		fs.emitError(new Error('ENOENT claude'));
		const events = await drain(stream);
		expect(events).toEqual([{ type: 'error', message: 'ENOENT claude' }]);
	});

	it('spawn() throwing synchronously → {error}', async () => {
		const throwingSpawn: CcSpawnFn = () => {
			throw new Error('spawn EACCES');
		};
		const { driver } = makeDriver({ spawn: throwingSpawn });
		const session = await driver.openSession({ aiclawUid: '5', roomId: '9', chatContext: BASE_CTX });
		const events = await drain(session.send('hi'));
		expect(events).toEqual([{ type: 'error', message: 'spawn EACCES' }]);
	});
});

describe('CcHeadlessSession.send — hooks bridge (tool via the registry; #120 thinking is stdout-teed)', () => {
	/** Drive a hook through the REAL broker → bridge sink → the session's registered room push. */
	function brokerFor(registry: CcSessionRegistry) {
		return new CcBroker({ resolve: parseCcBinding, sink: buildCcBridgeSink(registry) });
	}

	it('#120: a PostToolUse hook → {tool} appears in the stream; a MessageDisplay hook is now a no-op', async () => {
		const { driver, fs, registry } = makeDriver();
		const broker = brokerFor(registry);
		const session = await driver.openSession({ aiclawUid: '5', roomId: '9', chatContext: BASE_CTX });
		const stream = session.send('hi');

		// #120: MessageDisplay no longer produces a thinking event (thinking is teed from stdout instead).
		await broker.handle({ authToken: KEY, body: { hook_event_name: 'MessageDisplay', content: 'ignored now' } });
		await broker.handle({ authToken: KEY, body: { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { cmd: 'ls' } } });
		fs.emitStdout(`${JSON.stringify({ type: 'result' })}\n`);

		const events = await drain(stream);
		expect(events).toContainEqual({ type: 'tool', name: 'Bash', phase: 'end' });
		expect(events.some((e) => e.type === 'thinking')).toBe(false); // no hook-sourced thinking anymore
		expect(events[events.length - 1].type).toBe('done');
	});

	it('ORDER boundary: a PostToolUse hook racing AFTER stdout-complete still flushes BEFORE done', async () => {
		const { driver, fs, registry } = makeDriver({ drainMs: 40 });
		const broker = brokerFor(registry);
		const session = await driver.openSession({ aiclawUid: '5', roomId: '9', chatContext: BASE_CTX });
		const stream = session.send('hi');

		// stdout says the turn is complete FIRST (starts the drain window)...
		fs.emitStdout(`${JSON.stringify({ type: 'result' })}\n`);
		// ...then a final tool hook lands DURING the drain (the race the drain protects against).
		await broker.handle({ authToken: KEY, body: { hook_event_name: 'PostToolUse', tool_name: 'Grep' } });

		const events = await drain(stream);
		const toolIdx = events.findIndex((e) => e.type === 'tool' && e.name === 'Grep');
		const doneIdx = events.findIndex((e) => e.type === 'done');
		expect(toolIdx).toBeGreaterThanOrEqual(0);
		expect(doneIdx).toBeGreaterThanOrEqual(0);
		expect(toolIdx).toBeLessThan(doneIdx); // tail tool flushed before done
	});

	it('a hook for a room with NO active session (turn already finished) is a safe no-op (no throw)', async () => {
		const { driver, fs, registry } = makeDriver();
		const broker = brokerFor(registry);
		const session = await driver.openSession({ aiclawUid: '5', roomId: '9', chatContext: BASE_CTX });
		const stream = session.send('hi');
		fs.emitStdout(`${JSON.stringify({ type: 'result' })}\n`);
		await drain(stream); // session finished → deregistered from the room

		const res = await broker.handle({ authToken: KEY, body: { hook_event_name: 'PostToolUse', tool_name: 'Bash' } });
		expect(res.status).toBe(200); // resolved fine; the bridge just drops it
	});
});

describe('CcHeadlessSession/Driver — cleanup (AC8: no orphaned process groups)', () => {
	it('close() kills the child process group (kill(-pid, SIGTERM)) and finishes the stream', async () => {
		const { driver, fs, kill } = makeDriver();
		const session = await driver.openSession({ aiclawUid: '5', roomId: '9', chatContext: BASE_CTX });
		const collected: AgentEvent[] = [];
		const consumed = (async () => {
			for await (const ev of session.send('hi')) collected.push(ev);
		})();
		await new Promise((r) => setImmediate(r));

		await session.close();
		await consumed;
		expect(kill).toHaveBeenCalledWith(-fs.child.pid!, 'SIGTERM');
		expect(collected).toEqual([]); // closed before any event
	});

	it('driver.disconnect() reaps every active child (node teardown handler)', async () => {
		const { driver, fs, kill } = makeDriver();
		const session = await driver.openSession({ aiclawUid: '5', roomId: '9', chatContext: BASE_CTX });
		void session.send('hi'); // spawns the child, registers as active

		await driver.disconnect();
		expect(kill).toHaveBeenCalledWith(-fs.child.pid!, 'SIGTERM');
	});

	it('a normally-completed turn removes itself from the active set (disconnect does not re-kill it)', async () => {
		const { driver, fs, kill } = makeDriver();
		const session = await driver.openSession({ aiclawUid: '5', roomId: '9', chatContext: BASE_CTX });
		const stream = session.send('hi');
		fs.emitStdout(`${JSON.stringify({ type: 'result' })}\n`);
		await drain(stream); // finish() → onClosed → removed from active; normal exit does NOT kill

		expect(kill).not.toHaveBeenCalled();
		await driver.disconnect(); // nothing left to reap
		expect(kill).not.toHaveBeenCalled();
	});
});

// ─── REQ-013 S1: the driver forwards the unified envelope (built upstream) verbatim ───
// The envelope FORMAT itself is covered by handler/envelope.test.ts; here we only prove the driver
// writes whatever envelope it is given, unchanged, into the stdin user message.

describe('CcHeadlessDriver — REQ-013 S1 forwards the given envelope verbatim', () => {
	it('a DM-style envelope passed to send() appears verbatim in the stdin user message', async () => {
		const { driver, fs } = makeDriver();
		const session = await driver.openSession({ aiclawUid: '5', roomId: '9', chatContext: { roomType: 2, roomId: '9' } });
		session.send('[HuLa 私聊]\n[阿强(100)]: 你好');
		expect(stdinText(fs)).toBe('[HuLa 私聊]\n[阿强(100)]: 你好');
	});

	it('a group envelope with accumulated lines passed to send() appears verbatim in the stdin user message', async () => {
		const { driver, fs } = makeDriver();
		const envelope = '[HuLa 群聊]\n[alice(100)]: first\n[bob(101)]: second\n[dave(102)]: hey bot';
		const session = await driver.openSession({ aiclawUid: '5', roomId: '9', chatContext: BASE_CTX });
		session.send(envelope);
		expect(stdinText(fs)).toBe(envelope);
	});
});

// ─── REQ-011 S3 (AC9): per-room transcript — inbound + teed CC output ───

describe('CcHeadlessDriver — REQ-011 S3 transcript (owner replaces watching the terminal)', () => {
	it('a turn appends the INBOUND (attributed) record + the CC OUTPUT events (assistant/tool/thinking) with ts+session_id', async () => {
		const { driver, fs, transcript } = makeDriver();
		const session = await driver.openSession({ aiclawUid: '5', roomId: '9', chatContext: { roomType: 2, roomId: '9' } });
		// REQ-013 S1: the inbound record is the given envelope verbatim (built upstream), not re-derived here.
		const stream = session.send('[HuLa 私聊]\n[阿强(100)]: 你好');

		fs.emitStdout(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-abc' })}\n`);
		// an assistant event carrying text + thinking + tool_use content blocks → three output records
		fs.emitStdout(
			`${JSON.stringify({
				type: 'assistant',
				message: {
					content: [
						{ type: 'thinking', thinking: 'let me think' },
						{ type: 'text', text: 'hello there' },
						{ type: 'tool_use', name: 'Bash', input: { cmd: 'ls' } },
					],
				},
			})}\n`,
		);
		fs.emitStdout(`${JSON.stringify({ type: 'result' })}\n`);
		await drain(stream);

		const recs = transcript.records.filter((r) => r.key === KEY).map((r) => r.record);
		// inbound first, carrying the attributed text
		expect(recs[0].kind).toBe('inbound');
		expect(recs[0].text).toBe('[HuLa 私聊]\n[阿强(100)]: 你好');
		// then the teed CC output (assistant text / thinking / tool_use), each with the captured session_id
		expect(recs).toContainEqual(expect.objectContaining({ kind: 'thinking', text: 'let me think', session_id: 'sid-abc' }));
		expect(recs).toContainEqual(expect.objectContaining({ kind: 'assistant', text: 'hello there', session_id: 'sid-abc' }));
		expect(recs).toContainEqual(expect.objectContaining({ kind: 'tool_use', tool: 'Bash', session_id: 'sid-abc' }));
		// every record carries a numeric ts
		expect(recs.every((r) => typeof r.ts === 'number')).toBe(true);
		// #120: text/thinking blocks ALSO feed the thinking panel (covered above); the REPLY is never
		// parsed from stdout — it goes out-of-band via the `aichat send-message` CLI capability.
	});

	it('appends (never overwrites) across turns — a second send() adds more records', async () => {
		const { driver, fs, transcript } = makeDriver();
		const ctx = { roomType: 2, roomId: '9', fromName: 'u', counterpartUid: '100' };

		const s1 = await driver.openSession({ aiclawUid: '5', roomId: '9', chatContext: ctx });
		const st1 = s1.send('turn-1');
		fs.emitStdout(`${JSON.stringify({ type: 'result' })}\n`);
		await drain(st1);
		const afterTurn1 = transcript.records.filter((r) => r.key === KEY).length;

		const s2 = await driver.openSession({ aiclawUid: '5', roomId: '9', chatContext: ctx });
		s2.send('turn-2');
		const afterTurn2 = transcript.records.filter((r) => r.key === KEY).length;

		expect(afterTurn1).toBeGreaterThanOrEqual(1);
		expect(afterTurn2).toBeGreaterThan(afterTurn1); // appended, not reset
		const inbound = transcript.records.filter((r) => r.record.kind === 'inbound').map((r) => r.record.text);
		expect(inbound.some((t) => t?.includes('turn-1'))).toBe(true);
		expect(inbound.some((t) => t?.includes('turn-2'))).toBe(true);
	});

	it('a tool_use block captures the FULL input as tool_input = JSON.stringify(input)', async () => {
		const { driver, fs, transcript } = makeDriver();
		const session = await driver.openSession({ aiclawUid: '5', roomId: '9', chatContext: BASE_CTX });
		const stream = session.send('hi');

		const input = { cmd: 'ls -la', dir: '/tmp', flags: ['a', 'b'] };
		fs.emitStdout(
			`${JSON.stringify({
				type: 'assistant',
				message: { content: [{ type: 'tool_use', name: 'Bash', input }] },
			})}\n`,
		);
		fs.emitStdout(`${JSON.stringify({ type: 'result' })}\n`);
		await drain(stream);

		const rec = transcript.records.filter((r) => r.key === KEY).map((r) => r.record).find((r) => r.kind === 'tool_use');
		expect(rec).toBeDefined();
		expect(rec!.tool).toBe('Bash');
		expect(rec!.tool_input).toBe(JSON.stringify(input));
	});

	it('an oversized tool_use input is truncated to the cap with a truncation marker', async () => {
		const { driver, fs, transcript } = makeDriver();
		const session = await driver.openSession({ aiclawUid: '5', roomId: '9', chatContext: BASE_CTX });
		const stream = session.send('hi');

		// a huge input → stringified length far exceeds the 2000-char cap
		const input = { blob: 'x'.repeat(10_000) };
		const fullLen = JSON.stringify(input).length;
		fs.emitStdout(
			`${JSON.stringify({
				type: 'assistant',
				message: { content: [{ type: 'tool_use', name: 'Bash', input }] },
			})}\n`,
		);
		fs.emitStdout(`${JSON.stringify({ type: 'result' })}\n`);
		await drain(stream);

		const rec = transcript.records.filter((r) => r.key === KEY).map((r) => r.record).find((r) => r.kind === 'tool_use');
		expect(rec).toBeDefined();
		expect(rec!.tool_input).toBeDefined();
		// bounded: the marker adds a small suffix, so length stays close to (but above) the 2000 cap and
		// well under the full serialized length.
		expect(rec!.tool_input!.length).toBeLessThan(fullLen);
		expect(rec!.tool_input!.length).toBeLessThanOrEqual(2000 + 40);
		expect(rec!.tool_input).toContain('[truncated');
	});
});

// ─── REQ-011 S3 (§3): session reset → next turn spawns fresh (no --resume) ───

describe('CcHeadlessDriver — REQ-011 S3 resetSession', () => {
	it('resetSession deletes the stored session_id → the next send() argv has NO --resume', async () => {
		const { driver, fs, store } = makeDriver();
		store.set(KEY, { sessionId: 'sid-prev' });

		// sanity: without reset a turn WOULD resume
		driver.resetSession(5, 9);
		expect(store.map.has(KEY)).toBe(false);

		const session = await driver.openSession({ aiclawUid: '5', roomId: '9', chatContext: BASE_CTX });
		session.send('hi');
		expect(fs.spawnCall!.args).not.toContain('--resume');
	});

	it('first-trigger (no stored session_id) still spawns fresh — reset changes nothing there', async () => {
		const { driver, fs } = makeDriver();
		driver.resetSession(5, 9); // no-op on an empty store
		const session = await driver.openSession({ aiclawUid: '5', roomId: '9', chatContext: BASE_CTX });
		session.send('hi');
		expect(fs.spawnCall!.args).not.toContain('--resume');
	});
});

// ─── REQ-011 S5 (#112): --resume self-heal (dead session_id after a container redeploy) ───

describe('CcHeadlessSession.send — REQ-011 S5 --resume self-heal', () => {
	it('dead-resume (non-zero exit) self-heals: clears the stored id, retries fresh, succeeds', async () => {
		const fms = fakeMultiSpawn();
		const { driver, store, kill } = makeDriver({ spawn: fms.spawn });
		store.set(KEY, { sessionId: 'sid-dead' });
		const session = await driver.openSession({ aiclawUid: '5', roomId: '9', chatContext: BASE_CTX });
		const stream = session.send('hi');

		// attempt 1 resumed the (now dead) session and then failed non-zero
		expect(fms.calls.length).toBe(1);
		expect(fms.calls[0].args).toContain('--resume');
		expect(fms.calls[0].args[fms.calls[0].args.indexOf('--resume') + 1]).toBe('sid-dead');
		fms.calls[0].emitStderr('No conversation found with session ID sid-dead');
		fms.calls[0].emitExit(1);

		// self-heal: exactly ONE retry, FRESH (no --resume), and the dead id was cleared before it
		expect(fms.calls.length).toBe(2);
		expect(fms.calls[1].args).not.toContain('--resume');
		// the resume-child's process group was reaped
		expect(kill).toHaveBeenCalledWith(-fms.calls[0].pid, 'SIGTERM');

		// drive the fresh attempt to success
		fms.calls[1].emitStdout(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-new' })}\n`);
		fms.calls[1].emitStdout(`${JSON.stringify({ type: 'result' })}\n`);
		const events = await drain(stream);

		expect(events.some((e) => e.type === 'error')).toBe(false);
		expect(events[events.length - 1].type).toBe('done');
		expect(store.map.get(KEY)?.sessionId).toBe('sid-new'); // fresh attempt re-populated the store
		expect(fms.calls.length).toBe(2); // no third spawn
	});

	it('dead-resume (first-event timeout) self-heals: kills the resume-child group, retries fresh', async () => {
		vi.useFakeTimers();
		try {
			const fms = fakeMultiSpawn();
			const { driver, store, kill } = makeDriver({ spawn: fms.spawn, firstEventTimeoutMs: 20, drainMs: 10 });
			store.set(KEY, { sessionId: 'sid-dead' });
			const session = await driver.openSession({ aiclawUid: '5', roomId: '9', chatContext: BASE_CTX });
			const stream = session.send('hi');

			// attempt 1 resumed but emits NO stdout within the watchdog window
			expect(fms.calls.length).toBe(1);
			expect(fms.calls[0].args).toContain('--resume');
			await vi.advanceTimersByTimeAsync(20); // first-event timeout fires → self-heal

			expect(fms.calls.length).toBe(2);
			expect(fms.calls[1].args).not.toContain('--resume');
			expect(store.map.has(KEY)).toBe(false); // dead id cleared before the retry
			expect(kill).toHaveBeenCalledWith(-fms.calls[0].pid, 'SIGTERM'); // resume-child group reaped

			// fresh attempt succeeds
			fms.calls[1].emitStdout(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-new' })}\n`);
			fms.calls[1].emitStdout(`${JSON.stringify({ type: 'result' })}\n`);
			await vi.advanceTimersByTimeAsync(10); // drain window
			const events = await drain(stream);

			expect(events.some((e) => e.type === 'error')).toBe(false);
			expect(events[events.length - 1].type).toBe('done');
			expect(store.map.get(KEY)?.sessionId).toBe('sid-new');
		} finally {
			vi.useRealTimers();
		}
	});

	it('dead-resume (spawn `error` event) self-heals: retries fresh', async () => {
		const fms = fakeMultiSpawn();
		const { driver, store } = makeDriver({ spawn: fms.spawn });
		store.set(KEY, { sessionId: 'sid-dead' });
		const session = await driver.openSession({ aiclawUid: '5', roomId: '9', chatContext: BASE_CTX });
		const stream = session.send('hi');

		expect(fms.calls[0].args).toContain('--resume');
		fms.calls[0].emitError(new Error('spawn hiccup'));

		expect(fms.calls.length).toBe(2);
		expect(fms.calls[1].args).not.toContain('--resume');
		expect(store.map.has(KEY)).toBe(false);

		fms.calls[1].emitStdout(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-new' })}\n`);
		fms.calls[1].emitStdout(`${JSON.stringify({ type: 'result' })}\n`);
		const events = await drain(stream);
		expect(events.some((e) => e.type === 'error')).toBe(false);
		expect(events[events.length - 1].type).toBe('done');
	});

	it('valid-resume is UNAFFECTED: a resuming attempt that succeeds does NOT clear or re-spawn', async () => {
		const fms = fakeMultiSpawn();
		const { driver, store } = makeDriver({ spawn: fms.spawn });
		store.set(KEY, { sessionId: 'sid-live' });
		const session = await driver.openSession({ aiclawUid: '5', roomId: '9', chatContext: BASE_CTX });
		const stream = session.send('hi');

		expect(fms.calls.length).toBe(1);
		expect(fms.calls[0].args).toContain('--resume');
		expect(fms.calls[0].args[fms.calls[0].args.indexOf('--resume') + 1]).toBe('sid-live');

		fms.calls[0].emitStdout(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-live2' })}\n`);
		fms.calls[0].emitStdout(`${JSON.stringify({ type: 'result' })}\n`);
		const events = await drain(stream);

		expect(fms.calls.length).toBe(1); // no self-heal retry
		expect(events.some((e) => e.type === 'error')).toBe(false);
		expect(events[events.length - 1].type).toBe('done');
		expect(store.map.get(KEY)?.sessionId).toBe('sid-live2'); // store follows the resumed turn's new id
	});

	it('fresh attempt failure does NOT retry (no stored session → single spawn → {error})', async () => {
		const fms = fakeMultiSpawn();
		const { driver, store } = makeDriver({ spawn: fms.spawn });
		// no stored session_id
		const session = await driver.openSession({ aiclawUid: '5', roomId: '9', chatContext: BASE_CTX });
		const stream = session.send('hi');

		expect(fms.calls[0].args).not.toContain('--resume');
		fms.calls[0].emitStderr('genuine failure');
		fms.calls[0].emitExit(1);
		const events = await drain(stream);

		expect(fms.calls.length).toBe(1); // fresh failure is not retried
		expect(events).toHaveLength(1);
		expect(events[0].type).toBe('error');
		expect((events[0] as { message: string }).message).toContain('claude exited 1');
		expect(store.map.has(KEY)).toBe(false);
	});

	it('dead-resume then fresh retry ALSO fails → exactly TWO spawns then {error} (no third)', async () => {
		const fms = fakeMultiSpawn();
		const { driver, store } = makeDriver({ spawn: fms.spawn });
		store.set(KEY, { sessionId: 'sid-dead' });
		const session = await driver.openSession({ aiclawUid: '5', roomId: '9', chatContext: BASE_CTX });
		const stream = session.send('hi');

		// attempt 1 (resume) fails → self-heal
		fms.calls[0].emitExit(1);
		expect(fms.calls.length).toBe(2);
		expect(fms.calls[1].args).not.toContain('--resume');
		// attempt 2 (fresh) ALSO fails → genuine error, no third attempt
		fms.calls[1].emitStderr('still broken');
		fms.calls[1].emitExit(1);
		const events = await drain(stream);

		expect(fms.calls.length).toBe(2);
		expect(events).toHaveLength(1);
		expect(events[0].type).toBe('error');
		expect((events[0] as { message: string }).message).toContain('claude exited 1');
	});

	it('a stale (killed) resume-child late event is IGNORED: no spurious {error}/{done}, fresh attempt undisturbed', async () => {
		const fms = fakeMultiSpawn();
		const { driver, store } = makeDriver({ spawn: fms.spawn });
		store.set(KEY, { sessionId: 'sid-dead' });
		const session = await driver.openSession({ aiclawUid: '5', roomId: '9', chatContext: BASE_CTX });
		const stream = session.send('hi');

		// attempt 1 (resume) fails → self-heal to a fresh attempt 2
		fms.calls[0].emitExit(1);
		expect(fms.calls.length).toBe(2);

		// the OLD resume-child now emits late events (e.g. from the kill) — they must be dropped
		fms.calls[0].emitStdout(`${JSON.stringify({ type: 'result' })}\n`);
		fms.calls[0].emitExit(137);
		fms.calls[0].endStdout();

		// the fresh attempt proceeds normally and is the ONLY thing that drives the stream
		fms.calls[1].emitStdout(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-new' })}\n`);
		fms.calls[1].emitStdout(`${JSON.stringify({ type: 'result' })}\n`);
		const events = await drain(stream);

		expect(events.some((e) => e.type === 'error')).toBe(false);
		expect(events.filter((e) => e.type === 'done')).toHaveLength(1); // exactly one done, from the fresh attempt
		expect(store.map.get(KEY)?.sessionId).toBe('sid-new');
	});

	// ── the real-machine bug (#112 follow-up): a dead `--resume` emits an ERROR `result` on stdout
	// FIRST (then exits 1). The old `result` branch called complete() for ANY result → turnComplete
	// pre-empted the non-zero exit → self-heal never fired. An error result must route to the failure
	// path, not complete(). ──

	it('dead-resume via ERROR RESULT self-heals: clears the stored id, retries fresh, succeeds', async () => {
		const fms = fakeMultiSpawn();
		const { driver, store } = makeDriver({ spawn: fms.spawn });
		store.set(KEY, { sessionId: 'sid-dead' });
		const session = await driver.openSession({ aiclawUid: '5', roomId: '9', chatContext: BASE_CTX });
		const stream = session.send('hi');

		// attempt 1 resumed the (now dead) session
		expect(fms.calls.length).toBe(1);
		expect(fms.calls[0].args).toContain('--resume');
		expect(fms.calls[0].args[fms.calls[0].args.indexOf('--resume') + 1]).toBe('sid-dead');

		// real `claude` emits an error `result` on stdout FIRST (then exit 1)
		fms.calls[0].emitStdout(
			`${JSON.stringify({
				type: 'result',
				subtype: 'error_during_execution',
				is_error: true,
				num_turns: 0,
				session_id: 'sid-dead',
				errors: ['No conversation found with session ID: sid-dead'],
			})}\n`,
		);

		// self-heal: dead id CLEARED, exactly ONE retry, FRESH (no --resume)
		expect(store.map.has(KEY)).toBe(false);
		expect(fms.calls.length).toBe(2);
		expect(fms.calls[1].args).not.toContain('--resume');

		// drive the fresh attempt to success
		fms.calls[1].emitStdout(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-new' })}\n`);
		fms.calls[1].emitStdout(`${JSON.stringify({ type: 'result' })}\n`);

		// the OLD resume-child's late exit(1) after the error result must be dropped by the stale guard
		fms.calls[0].emitExit(1);

		const events = await drain(stream);

		expect(events.some((e) => e.type === 'error')).toBe(false); // no {error}: it self-healed
		expect(events.filter((e) => e.type === 'done')).toHaveLength(1); // exactly one done, from the fresh attempt
		expect(store.map.get(KEY)?.sessionId).toBe('sid-new'); // fresh attempt re-populated the store
		expect(fms.calls.length).toBe(2); // no third spawn
	});

	it('error-result on a FRESH attempt surfaces {error} (no stored session → no retry)', async () => {
		const fms = fakeMultiSpawn();
		const { driver, store } = makeDriver({ spawn: fms.spawn });
		// no stored session_id → fresh attempt
		const session = await driver.openSession({ aiclawUid: '5', roomId: '9', chatContext: BASE_CTX });
		const stream = session.send('hi');

		expect(fms.calls[0].args).not.toContain('--resume');
		fms.calls[0].emitStdout(
			`${JSON.stringify({
				type: 'result',
				subtype: 'error_during_execution',
				is_error: true,
				session_id: 'sid-x',
				errors: ['No conversation found with session ID: sid-x'],
			})}\n`,
		);
		const events = await drain(stream);

		expect(fms.calls.length).toBe(1); // fresh error is not retried
		expect(events).toHaveLength(1);
		expect(events[0].type).toBe('error');
		expect((events[0] as { message: string }).message).toContain('No conversation found');
	});

	it('success result STILL completes (regression): a normal `result` (no is_error) → {done}, single spawn', async () => {
		const fms = fakeMultiSpawn();
		const { driver, store } = makeDriver({ spawn: fms.spawn });
		const session = await driver.openSession({ aiclawUid: '5', roomId: '9', chatContext: BASE_CTX });
		const stream = session.send('hi');

		fms.calls[0].emitStdout(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-ok' })}\n`);
		fms.calls[0].emitStdout(`${JSON.stringify({ type: 'result', subtype: 'success', session_id: 'sid-ok' })}\n`);
		const events = await drain(stream);

		expect(fms.calls.length).toBe(1); // no retry on success
		expect(events.some((e) => e.type === 'error')).toBe(false);
		expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
		expect(store.map.get(KEY)?.sessionId).toBe('sid-ok');
	});
});

describe('parseCcBinding', () => {
	it('valid binding → uids', () => {
		expect(parseCcBinding('aiclaw-12-room-34')).toEqual({ aiclawUid: '12', roomId: '34' });
	});

	it('REQ-029 (#29): a >2^53 binding parses to EXACT strings (Number() would corrupt)', () => {
		expect(parseCcBinding('aiclaw-9007199254740993-room-9007199254740994')).toEqual({
			aiclawUid: '9007199254740993',
			roomId: '9007199254740994',
		});
	});

	it('garbage → undefined', () => {
		expect(parseCcBinding('garbage')).toBeUndefined();
		expect(parseCcBinding('')).toBeUndefined();
		expect(parseCcBinding('aiclaw-1-room-')).toBeUndefined();
		expect(parseCcBinding('aiclaw--room-2')).toBeUndefined();
	});

	it('still-prefixed cc:… → undefined (the endpoint must strip cc: first)', () => {
		expect(parseCcBinding('cc:aiclaw-1-room-2')).toBeUndefined();
	});
});
