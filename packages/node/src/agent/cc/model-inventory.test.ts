import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readCcModelInventory } from './model-inventory.js';
import { DriverDisconnectIncompleteError } from '../events.js';
import type { CcSpawnFn } from './headless-driver.js';
import { spawnWindowsJob } from './windows-job.js';

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

function fixture() {
	const child = Object.assign(new EventEmitter(), {
		pid: 4242, stdin: { write: vi.fn<(chunk: string) => void>(), end: vi.fn() },
		stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(() => true),
	});
	const spawn = vi.fn<CcSpawnFn>(() => child);
	let groupAlive = true;
	const kill = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
		if (pid === -child.pid && signal === 0 && !groupAlive)
			throw Object.assign(new Error('gone'), { code: 'ESRCH' });
	});
	const abort = new AbortController();
	const start = () => readCcModelInventory({ cwd: process.cwd(), signal: abort.signal, spawn, kill, platform: 'linux' });
	const initialize = () => JSON.parse(child.stdin.write.mock.calls[0][0]);
	const response = (requestId = initialize().request_id, models: unknown = [{ value: 'native-choice', displayName: 'Modèle', provider: 'untrusted' }]) =>
		JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { models, version: 'untrusted' } } }) + '\n';
	return { child, spawn, kill, abort, start, initialize, response,
		close: (code = 0) => child.emit('close', code, null), exitGroup: () => { groupAlive = false; } };
}

it('requests one native inventory with no user input and returns only its projection after confirmed exit', async () => {
	vi.stubEnv('AICHAT_RUN_BIND', 'app-only');
	vi.stubEnv('OPENCLAW_BIND', 'app-only');
	const f = fixture();
	const result = f.start();
	let resolved = false;
	void result.then(() => { resolved = true; }, () => {});
	expect(f.spawn).toHaveBeenCalledTimes(1);
	expect(f.spawn).toHaveBeenCalledWith('claude', [
		'-p', '--safe-mode', '--no-session-persistence', '--input-format', 'stream-json', '--output-format', 'stream-json',
		'--verbose', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
	], expect.objectContaining({ cwd: process.cwd(), detached: true, stdio: ['pipe', 'pipe', 'pipe'] }));
	const { env } = f.spawn.mock.calls[0][2];
	expect(env).toMatchObject({ CLAUDE_NON_INTERACTIVE: '1', MAX_RETRIES: '0' });
	expect(env).not.toHaveProperty('AICHAT_RUN_BIND');
	expect(env).not.toHaveProperty('OPENCLAW_BIND');
	expect(f.initialize()).toEqual({ type: 'control_request', request_id: expect.stringMatching(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/),
		request: { subtype: 'initialize' } });
	expect(f.child.stdin.end).not.toHaveBeenCalled();
	const bytes = Buffer.from(f.response());
	const split = bytes.indexOf(Buffer.from('è')) + 1;
	f.child.stdout.emit('data', bytes.subarray(0, split));
	expect(f.child.stdin.end).not.toHaveBeenCalled();
	f.child.stdout.emit('data', bytes.subarray(split));
	expect(f.child.stdin.end).toHaveBeenCalledTimes(1);
	await Promise.resolve();
	expect(resolved).toBe(false);
	f.exitGroup();
	f.close();
	await expect(result).resolves.toEqual([{ value: 'native-choice', displayName: 'Modèle' }]);
	expect(f.child.stdin.write).toHaveBeenCalledTimes(1);
	expect(f.kill.mock.calls).toEqual([[-4242, 0]]);
});

it('never launches on pre-abort, and waits for cleanup after an in-flight abort', async () => {
	const before = fixture();
	before.abort.abort('must not leak');
	await expect(before.start()).rejects.toThrow(/^CC model inventory aborted$/);
	expect(before.spawn).not.toHaveBeenCalled();

	const f = fixture();
	const result = f.start();
	let rejected = false;
	void result.catch(() => { rejected = true; });
	f.abort.abort('must not leak');
	expect(f.kill).toHaveBeenCalledWith(-4242, 'SIGTERM');
	await Promise.resolve();
	expect(rejected).toBe(false);
	f.exitGroup();
	f.close();
	await expect(result).rejects.toThrow(/^CC model inventory aborted$/);
});

it.each([
	['stale UUID', (f: ReturnType<typeof fixture>) => f.response('stale')],
	['malformed JSON', () => 'private-native-diagnostic\n'],
	['invalid field', (f: ReturnType<typeof fixture>) => f.response(undefined, [{ value: 'secret\n', displayName: 'model' }])],
	['duplicate response', (f: ReturnType<typeof fixture>) => f.response() + f.response()],
	['oversized stdout', () => Buffer.alloc(512 * 1024 + 1)],
])('fails closed without native diagnostics for %s', async (_case, output) => {
	const f = fixture();
	const result = f.start();
	f.child.stderr.emit('data', 'private-native-diagnostic');
	f.child.stdout.emit('data', output(f));
	expect(f.kill).toHaveBeenCalledWith(-4242, 'SIGTERM');
	f.exitGroup();
	f.close();
	await expect(result).rejects.toThrow(/^CC model inventory (?:received (?:an unexpected frame|malformed output)|returned invalid models|stdout limit exceeded)$/);
});

it('escalates only the owned group and reports unconfirmed cleanup, not a successful inventory', async () => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
	const f = fixture();
	const result = f.start();
	const rejection = result.catch((error: unknown) => error);
	f.child.stdout.emit('data', f.response());
	f.close(); // A root's zero exit is not proof that its group has exited.
	expect(f.kill).toHaveBeenCalledWith(-4242, 'SIGTERM');
	await vi.advanceTimersByTimeAsync(3000);
	expect(f.kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
	await vi.advanceTimersByTimeAsync(4000);
	expect(await rejection).toBeInstanceOf(DriverDisconnectIncompleteError);
	expect(vi.getTimerCount()).toBe(0);
});

const hasSupervisor = process.platform !== 'win32' ||
	existsSync(join(import.meta.dirname, '../../../dist/native/cc-job-supervisor.exe'));
it.skipIf(!hasSupervisor)('finishes a real owned subprocess over the initialize/EOF handshake', async () => {
	// Substitute Node for Claude, but keep the actual platform's ownership and pipe implementation.
	const nativeFixture = `const lines = require('node:readline').createInterface({ input: process.stdin });
		const deadline = setTimeout(() => process.exit(1), 3000);
		let count = 0;
		lines.on('line', text => {
			const frame = JSON.parse(text);
			if (++count !== 1 || frame.type !== 'control_request' || frame.request.subtype !== 'initialize') process.exit(1);
			console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id,
				response: { models: [{ value: 'fixture', displayName: 'Fixture model' }] } } }));
		});
		lines.on('close', () => { clearTimeout(deadline); process.exitCode = count === 1 ? 0 : 1; });`;
	const spawn: CcSpawnFn = (_cmd, _args, options) => (process.platform === 'win32' ? spawnWindowsJob : nodeSpawn)(
		process.execPath, ['-e', nativeFixture], options);
	await expect(readCcModelInventory({ cwd: process.cwd(), signal: AbortSignal.timeout(4000), spawn })).resolves.toEqual([
		{ value: 'fixture', displayName: 'Fixture model' },
	]);
}, 12_000);
