import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { ConversationStore } from '../capability/conversations.js';
import { capabilitySocketPath } from '../capability/endpoint.js';
import { AICHAT_HOME, getServerUrl, loadConfig } from '../config.js';
import { restBaseUrlFromWsUrl } from '../api/hula-api.js';

/** Owner-only offline maintenance. Never expose this through the capability registry/agent request API. */
export async function handleRecoverRun(args: string[]): Promise<void> {
	try {
		const config = loadConfig();
		await recoverRun(args, {
			home: AICHAT_HOME,
			serverNamespace: restBaseUrlFromWsUrl(getServerUrl(config)),
			socketPath: capabilitySocketPath(),
		});
	} catch (err) {
		console.error(`recover-run: ${err instanceof Error ? err.message : String(err)}`);
		process.exitCode = 1;
	}
}

/** The caller must have independently verified this exact upstream run stopped. No auto-stop inference. */
export async function recoverRun(args: string[], options: { home: string; serverNamespace: string; socketPath: string }): Promise<void> {
	if (args.length !== 2 || args[0]?.startsWith('-') || !args[0]?.trim() || args[1] !== '--verified-stopped')
		throw new Error('usage: aichat recover-run <runId> --verified-stopped (manually verify the upstream run has stopped first)');
	const runId = args[0];
	const statePath = join(options.home, 'conversations.json');
	if (!existsSync(statePath)) throw new Error('no existing conversation state; refusing to create recovery state');
	const lockPath = join(options.home, 'conversation-writer.lock');
	const token = `${process.pid}:${randomUUID()}`;
	// ponytail: never reclaim a stale lock here; owner must investigate/remove it offline before retrying.
	const fd = openSync(lockPath, 'wx', 0o600);
	const owned = fstatSync(fd);
	try {
		try { writeSync(fd, token); } finally { closeSync(fd); }
		await assertNoListener(options.socketPath);
		const store = new ConversationStore({ home: options.home, serverNamespace: options.serverNamespace, activeUids: new Set() });
		try {
			const pending = store.pendingRuns().find((run) => run.runId === runId);
			if (!pending) throw new Error(`runId ${runId} is not pending`);
			await assertNoListener(options.socketPath);
			store.confirmStopped(runId);
			console.log(`Confirmed stopped run ${runId} (conversation ${pending.conversationId}, identity ${pending.identityId}, room ${pending.roomId}). Other pending runs remain blocked.`);
		} finally { store.close(); }
	} finally {
		try { closeSync(fd); } catch { /* already closed */ }
		try {
			const current = lstatSync(lockPath);
			if (current.dev === owned.dev && current.ino === owned.ino && readFileSync(lockPath, 'utf8') === token) unlinkSync(lockPath);
		} catch { /* never remove another writer's lock */ }
	}
}

/** A refused/missing socket is offline; connected, timeout and unknown probe failures all reject. */
async function assertNoListener(path: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const socket = createConnection(path);
		socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('capability socket probe timed out; offline status unknown')); });
		socket.once('connect', () => { socket.destroy(); reject(new Error('capability endpoint still listening; stop daemon before recovery')); });
		socket.once('error', (err: NodeJS.ErrnoException) => {
			if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') resolve();
			else reject(new Error(`capability socket probe failed (${err.code ?? 'unknown'}); offline status unknown`));
		});
	});
}
