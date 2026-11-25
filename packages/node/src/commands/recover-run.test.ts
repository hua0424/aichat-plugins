import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { ConversationStore } from '../capability/conversations.js';
import { recoverRun } from './recover-run.js';

const beforeProbe = vi.hoisted(() => vi.fn());
vi.mock('node:net', async (importOriginal) => {
	const net = await importOriginal<typeof import('node:net')>();
	return { ...net, createConnection: (path: string) => {
		beforeProbe();
		return net.createConnection(path);
	} };
});

const dirs: string[] = [];
afterEach(() => {
	beforeProbe.mockReset();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it.each([
	{ probe: 1, hold: true }, { probe: 2, hold: true }, { probe: 3, hold: true }, { probe: 1, hold: false },
])('stops offline recovery if its lease changes during probe $probe (CC hold: $hold)', async ({ probe, hold }) => {
	const home = mkdtempSync(join(tmpdir(), 'aichat-offline-race-'));
	dirs.push(home);
	const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\aichat-offline-race-${process.pid}-${probe}-${hold}` : join(home, 'capability.sock');
	const options = { home, serverNamespace: 'http://example.test', socketPath };
	const store = new ConversationStore({ ...options, activeUids: new Set(['1']) });
	store.beginRun('1', 'room-1', 'run-1');
	store.close();
	const statePath = join(home, 'conversations.json');
	const marker = join(home, 'cc-writer-armed.lock');
	const lease = join(home, 'conversation-writer.lock');
	let probeCount = 0;
	let stateAtLoss: string | undefined;
	beforeProbe.mockImplementation(() => {
		if (++probeCount !== probe) return;
		stateAtLoss = readFileSync(statePath, 'utf8');
		rmSync(lease);
		writeFileSync(lease, 'replacement-writer');
		if (hold) writeFileSync(marker, 'replacement CC writer');
	});

	await expect(recoverRun(['run-1', '--verified-stopped'], options)).rejects.toThrow(hold
		? 'CC cleanup unconfirmed; writer locked' : 'offline writer lease changed');
	expect(stateAtLoss).toBeDefined();
	expect(readFileSync(statePath, 'utf8')).toBe(stateAtLoss);
	expect(readFileSync(lease, 'utf8')).toBe('replacement-writer');
	if (hold) expect(readFileSync(marker, 'utf8')).toBe('replacement CC writer');
});

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
	const ccMarker = join(home, 'cc-writer-armed.lock');
	writeFileSync(ccMarker, 'uncertain, not ours');
	await expect(recoverRun(['run-1', '--verified-stopped'], opts)).rejects.toThrow('CC cleanup unconfirmed; writer locked');
	expect(readFileSync(ccMarker, 'utf8')).toBe('uncertain, not ours');
	expect(readFileSync(statePath, 'utf8')).toBe(before);
	expect(existsSync(lock)).toBe(false);
	rmSync(ccMarker);
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
