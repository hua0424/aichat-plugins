import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CcHeadlessDriver, type CcChild, type CcSpawnFn } from './headless-driver.js';
import { CC_REPLY_CONTRACT } from './launch.js';
import { CcSessionRegistry, buildCcBridgeSink } from './sink.js';
import { CcBroker } from './broker.js';
import { parseCcBinding } from './cc-driver.js';
import type { CcHeadlessSessionStore, StoredCcHeadlessSession } from './headless-session-store.js';
import type { AgentEvent } from '../events.js';

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

async function drain(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
	const out: AgentEvent[] = [];
	for await (const ev of stream) out.push(ev);
	return out;
}

const BASE_CTX = { roomType: 1, roomId: 9 };
const KEY = 'aiclaw-5-room-9';

function makeDriver(overrides: Partial<Parameters<typeof CcHeadlessDriver.prototype.constructor>[0]> = {}) {
	const fs = fakeSpawn();
	const registry = new CcSessionRegistry();
	const store = memStore();
	const kill = vi.fn();
	const driver = new CcHeadlessDriver({
		claudeBin: '/opt/claude',
		workspaceBase: freshBase(),
		brokerPort: 9100,
		sessionStore: store,
		registry,
		spawn: fs.spawn,
		kill,
		firstEventTimeoutMs: 1000,
		drainMs: 10,
		killGraceMs: 50,
		...overrides,
	});
	return { driver, fs, registry, store, kill };
}

describe('CcHeadlessDriver — shape', () => {
	it('type=cc, drivesTurns=true (node drives cc turns now)', () => {
		const { driver } = makeDriver();
		expect(driver.type).toBe('cc');
		expect(driver.drivesTurns).toBe(true);
	});

	it('resolveSession mirrors parseCcBinding', () => {
		const { driver } = makeDriver();
		expect(driver.resolveSession('aiclaw-7-room-8')).toEqual({ aiclawUid: 7, roomId: 8 });
		expect(driver.resolveSession('garbage')).toBeUndefined();
		expect(parseCcBinding('aiclaw-7-room-8')).toEqual(driver.resolveSession('aiclaw-7-room-8'));
	});

	it('connect/disconnect resolve; openSession returns a session', async () => {
		const { driver } = makeDriver();
		await expect(driver.connect()).resolves.toBeUndefined();
		const s = await driver.openSession({ aiclawUid: 5, roomId: 9, chatContext: BASE_CTX });
		expect(typeof s.send).toBe('function');
		await expect(driver.disconnect()).resolves.toBeUndefined();
	});
});

describe('CcHeadlessSession.send — spawn argv/env/stdin', () => {
	it('spawns claude with the exact headless argv, cc env, and writes the enriched stdin envelope', async () => {
		const { driver, fs } = makeDriver();
		const session = await driver.openSession({ aiclawUid: 5, roomId: 9, chatContext: BASE_CTX });
		session.send('原始用户消息');

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
			CC_REPLY_CONTRACT,
		]);
		// no stored session → no --resume
		expect(call.args).not.toContain('--resume');
		// #102 reply contract delivered at the SYSTEM level (once per turn) via --append-system-prompt,
		// NOT prepended to each stdin user message. The contract itself mandates the aichat send-message CLI.
		expect(CC_REPLY_CONTRACT).toContain('aichat send-message');

		const env = call.options.env as NodeJS.ProcessEnv;
		expect(env.AICHAT_BIND).toBe('aiclaw-5-room-9');
		expect(env.CLAUDE_NON_INTERACTIVE).toBe('1');
		expect(call.options.detached).toBe(true);
		expect(call.options.stdio).toEqual(['pipe', 'pipe', 'pipe']);

		// stdin envelope: ONE stream-json user message = the RAW user text only (the contract lives in
		// --append-system-prompt, not prepended here — no per-message content pollution), then EOF.
		expect(fs.stdinWrites.length).toBe(1);
		const env2 = JSON.parse(fs.stdinWrites[0].trim());
		expect(env2.type).toBe('user');
		const text = env2.message.content[0].text as string;
		expect(text).toBe('原始用户消息');
		expect(text).not.toContain('aichat send-message'); // contract is NOT in the user message
		expect(fs.stdinEnd).toHaveBeenCalledOnce();
	});
});

describe('CcHeadlessSession.send — stdout control-plane', () => {
	it('system:init → session_id stored; result → {done}; NO thinking/text yielded from stdout', async () => {
		const { driver, fs, store } = makeDriver();
		const session = await driver.openSession({ aiclawUid: 5, roomId: 9, chatContext: BASE_CTX });
		const stream = session.send('hi');

		fs.emitStdout(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-abc' })}\n`);
		// an assistant/text stdout event MUST NOT become a thinking event (reply comes from the CLI)
		fs.emitStdout(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello world' }] } })}\n`);
		fs.emitStdout(`${JSON.stringify({ type: 'result', subtype: 'success', session_id: 'sid-abc' })}\n`);

		const events = await drain(stream);
		expect(store.map.get(KEY)?.sessionId).toBe('sid-abc');
		expect(events).toEqual([{ type: 'done', durationMs: expect.any(Number) }]);
		expect(events.some((e) => e.type === 'thinking')).toBe(false);
	});

	it('EOF (stdout end) with no `result` still finishes as a backstop', async () => {
		const { driver, fs } = makeDriver();
		const session = await driver.openSession({ aiclawUid: 5, roomId: 9, chatContext: BASE_CTX });
		const stream = session.send('hi');
		fs.emitStdout(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-x' })}\n`);
		fs.endStdout();
		const events = await drain(stream);
		expect(events).toEqual([{ type: 'done', durationMs: expect.any(Number) }]);
	});

	it('tolerates a `data:` SSE-style prefix on stdout lines', async () => {
		const { driver, fs, store } = makeDriver();
		const session = await driver.openSession({ aiclawUid: 5, roomId: 9, chatContext: BASE_CTX });
		const stream = session.send('hi');
		fs.emitStdout(`data: ${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-sse' })}\n`);
		fs.emitStdout(`data: ${JSON.stringify({ type: 'result' })}\n`);
		await drain(stream);
		expect(store.map.get(KEY)?.sessionId).toBe('sid-sse');
	});
});

describe('CcHeadlessSession.send — resume', () => {
	it('a stored session_id for (uid,room) → argv has --resume <sid>; a new init rebinds the store', async () => {
		const { driver, fs, store } = makeDriver();
		store.set(KEY, { sessionId: 'sid-prev' });
		const session = await driver.openSession({ aiclawUid: 5, roomId: 9, chatContext: BASE_CTX });
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
		const session = await driver.openSession({ aiclawUid: 5, roomId: 9, chatContext: BASE_CTX });
		const events = await drain(session.send('hi'));
		expect(events).toEqual([{ type: 'error', message: 'first-event timeout' }]);
		// killed the GROUP (negative pid), SIGTERM
		expect(kill).toHaveBeenCalledWith(-fs.child.pid!, 'SIGTERM');
	});

	it('nonzero exit before completion → {error} with the exit code', async () => {
		const { driver, fs } = makeDriver();
		const session = await driver.openSession({ aiclawUid: 5, roomId: 9, chatContext: BASE_CTX });
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
		const session = await driver.openSession({ aiclawUid: 5, roomId: 9, chatContext: BASE_CTX });
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
		const session = await driver.openSession({ aiclawUid: 5, roomId: 9, chatContext: BASE_CTX });
		const events = await drain(session.send('hi'));
		expect(events).toEqual([{ type: 'error', message: 'spawn EACCES' }]);
	});
});

describe('CcHeadlessSession.send — hooks bridge (thinking/tool via the registry)', () => {
	/** Drive a hook through the REAL broker → bridge sink → the session's registered room push. */
	function brokerFor(registry: CcSessionRegistry) {
		return new CcBroker({ resolve: parseCcBinding, sink: buildCcBridgeSink(registry) });
	}

	it('MessageDisplay/PostToolUse hooks → {thinking}/{tool} appear in send()`s stream', async () => {
		const { driver, fs, registry } = makeDriver();
		const broker = brokerFor(registry);
		const session = await driver.openSession({ aiclawUid: 5, roomId: 9, chatContext: BASE_CTX });
		const stream = session.send('hi');

		await broker.handle({ authToken: KEY, body: { hook_event_name: 'MessageDisplay', content: 'thinking A' } });
		await broker.handle({ authToken: KEY, body: { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { cmd: 'ls' } } });
		fs.emitStdout(`${JSON.stringify({ type: 'result' })}\n`);

		const events = await drain(stream);
		expect(events).toContainEqual({ type: 'thinking', text: 'thinking A' });
		expect(events).toContainEqual({ type: 'tool', name: 'Bash', phase: 'end' });
		expect(events[events.length - 1].type).toBe('done');
	});

	it('ORDER boundary: a Stop-hook thinking racing AFTER stdout-complete still flushes BEFORE done', async () => {
		const { driver, fs, registry } = makeDriver({ drainMs: 40 });
		const broker = brokerFor(registry);
		const session = await driver.openSession({ aiclawUid: 5, roomId: 9, chatContext: BASE_CTX });
		const stream = session.send('hi');

		// stdout says the turn is complete FIRST (starts the drain window)...
		fs.emitStdout(`${JSON.stringify({ type: 'result' })}\n`);
		// ...then a final thinking hook lands DURING the drain (the race the drain protects against).
		await broker.handle({ authToken: KEY, body: { hook_event_name: 'MessageDisplay', content: 'tail thinking' } });

		const events = await drain(stream);
		const thinkingIdx = events.findIndex((e) => e.type === 'thinking' && e.text === 'tail thinking');
		const doneIdx = events.findIndex((e) => e.type === 'done');
		expect(thinkingIdx).toBeGreaterThanOrEqual(0);
		expect(doneIdx).toBeGreaterThanOrEqual(0);
		expect(thinkingIdx).toBeLessThan(doneIdx); // tail thinking flushed before done
	});

	it('a hook for a room with NO active session (turn already finished) is a safe no-op (no throw)', async () => {
		const { driver, fs, registry } = makeDriver();
		const broker = brokerFor(registry);
		const session = await driver.openSession({ aiclawUid: 5, roomId: 9, chatContext: BASE_CTX });
		const stream = session.send('hi');
		fs.emitStdout(`${JSON.stringify({ type: 'result' })}\n`);
		await drain(stream); // session finished → deregistered from the room

		const res = await broker.handle({ authToken: KEY, body: { hook_event_name: 'MessageDisplay', content: 'late' } });
		expect(res.status).toBe(200); // resolved fine; the bridge just drops it
	});
});

describe('CcHeadlessSession/Driver — cleanup (AC8: no orphaned process groups)', () => {
	it('close() kills the child process group (kill(-pid, SIGTERM)) and finishes the stream', async () => {
		const { driver, fs, kill } = makeDriver();
		const session = await driver.openSession({ aiclawUid: 5, roomId: 9, chatContext: BASE_CTX });
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
		const session = await driver.openSession({ aiclawUid: 5, roomId: 9, chatContext: BASE_CTX });
		void session.send('hi'); // spawns the child, registers as active

		await driver.disconnect();
		expect(kill).toHaveBeenCalledWith(-fs.child.pid!, 'SIGTERM');
	});

	it('a normally-completed turn removes itself from the active set (disconnect does not re-kill it)', async () => {
		const { driver, fs, kill } = makeDriver();
		const session = await driver.openSession({ aiclawUid: 5, roomId: 9, chatContext: BASE_CTX });
		const stream = session.send('hi');
		fs.emitStdout(`${JSON.stringify({ type: 'result' })}\n`);
		await drain(stream); // finish() → onClosed → removed from active; normal exit does NOT kill

		expect(kill).not.toHaveBeenCalled();
		await driver.disconnect(); // nothing left to reap
		expect(kill).not.toHaveBeenCalled();
	});
});
