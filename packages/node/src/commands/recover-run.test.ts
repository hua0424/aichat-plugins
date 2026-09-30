import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { ConversationStore } from '../capability/conversations.js';
import { recoverRun } from './recover-run.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('requires exact manual acknowledgement and exclusive offline writer lease, then confirms only the requested run', async () => {
	const home = mkdtempSync(join(tmpdir(), 'aichat-recover-'));
	dirs.push(home);
	const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\aichat-recover-test-${process.pid}-${Date.now()}` : join(home, 'capability.sock');
	const opts = { home, serverNamespace: 'http://example.test', socketPath };
	const store = new ConversationStore({ home, serverNamespace: opts.serverNamespace, activeUids: new Set(['1']) });
	store.beginRun('1', 'room-1', 'run-1');
	store.beginRun('1', 'room-2', 'run-2');
	store.close();
	const statePath = join(home, 'conversations.json');
	const before = readFileSync(statePath, 'utf8');
	await expect(recoverRun(['run-1'], opts)).rejects.toThrow('--verified-stopped');
	expect(readFileSync(statePath, 'utf8')).toBe(before);
	const lock = join(home, 'conversation-writer.lock');
	writeFileSync(lock, 'unknown owner');
	await expect(recoverRun(['run-1', '--verified-stopped'], opts)).rejects.toThrow();
	expect(readFileSync(lock, 'utf8')).toBe('unknown owner');
	rmSync(lock);
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	try {
		await expect(recoverRun(['run-1', '--verified-stopped'], opts)).rejects.toThrow('still listening');
		expect(readFileSync(statePath, 'utf8')).toBe(before);
		expect(existsSync(lock)).toBe(false);
	} finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
	await recoverRun(['run-1', '--verified-stopped'], opts);
	expect(existsSync(lock)).toBe(false);
	const after = new ConversationStore({ home, serverNamespace: opts.serverNamespace, activeUids: new Set(['1']) });
	expect(after.pendingRuns().map((run) => run.runId)).toEqual(['run-2']);
	expect(after.get('1', 'room-1')?.state).toBe('ready');
	expect(after.get('1', 'room-2')?.state).toBe('stop_unconfirmed');
	await expect(recoverRun(['run-1', '--verified-stopped'], opts)).rejects.toThrow('not pending');
});
