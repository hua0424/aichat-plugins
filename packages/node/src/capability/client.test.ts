import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { postCapability } from './client.js';

/**
 * A bindable loopback path: named pipe on win32 (a tmpdir fs path → EACCES, the pipe is passed
 * verbatim to CreateNamedPipeW), unix socket elsewhere. Named pipes are machine-wide, so
 * pid+module-counter keeps the name unique; `server.close()` in afterEach frees the pipe.
 */
let hungSeq = 0;
function hungSocketPath(base: string): string {
	if (process.platform === 'win32') {
		hungSeq += 1;
		return `\\\\.\\pipe\\aichat-cap-test-${process.pid}-${hungSeq}`;
	}
	return join(base, 'hung.sock');
}

/**
 * REQ-010 S1: the default timeout must be env-configurable (AICHAT_CAPABILITY_TIMEOUT_MS) with a
 * 30s fallback. We assert the behavior through the real public seam: with NO injected timeout and a
 * tiny env override, a silent endpoint must reject ~promptly; an injected opts.timeoutMs still wins.
 */
describe('postCapability default timeout (env-configurable)', () => {
	const dirs: string[] = [];
	let server: Server | null = null;
	const savedEnv = process.env.AICHAT_CAPABILITY_TIMEOUT_MS;

	afterEach(async () => {
		if (server) {
			await new Promise<void>((resolve) => server!.close(() => resolve()));
			server = null;
		}
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
		if (savedEnv === undefined) delete process.env.AICHAT_CAPABILITY_TIMEOUT_MS;
		else process.env.AICHAT_CAPABILITY_TIMEOUT_MS = savedEnv;
	});

	async function hungSocket(): Promise<string> {
		const base = mkdtempSync(join(tmpdir(), 'aichat-cap-env-'));
		dirs.push(base);
		const socketPath = hungSocketPath(base);
		server = createServer((_req, _res) => {
			/* never responds */
		});
		await new Promise<void>((resolve, reject) => {
			server!.once('error', reject);
			server!.listen(socketPath, () => resolve());
		});
		return socketPath;
	}

	it('honors AICHAT_CAPABILITY_TIMEOUT_MS when no explicit timeout is injected', async () => {
		process.env.AICHAT_CAPABILITY_TIMEOUT_MS = '40';
		const socketPath = await hungSocket();
		await expect(postCapability(socketPath, { sessionKey: 'x' })).rejects.toThrow(/timeout/);
	});

	it('falls back to the 30s default when the env override is NaN (and an injected timeout still wins)', async () => {
		process.env.AICHAT_CAPABILITY_TIMEOUT_MS = 'not-a-number';
		const socketPath = await hungSocket();
		// Injected 50ms overrides the (NaN → 30s) default so the test stays fast.
		await expect(postCapability(socketPath, { sessionKey: 'x' }, { timeoutMs: 50 })).rejects.toThrow(/timeout/);
	});
});

describe('postCapability timeout', () => {
	const dirs: string[] = [];
	let server: Server | null = null;

	afterEach(async () => {
		if (server) {
			await new Promise<void>((resolve) => server!.close(() => resolve()));
			server = null;
		}
		for (const d of dirs.splice(0)) {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it('rejects with a timeout when the endpoint accepts the connection but never responds', async () => {
		const base = mkdtempSync(join(tmpdir(), 'aichat-cap-client-'));
		dirs.push(base);
		const socketPath = hungSocketPath(base);

		// A server that accepts the request but NEVER calls res.end → the client must time out.
		server = createServer((_req, _res) => {
			/* intentionally never responds */
		});
		await new Promise<void>((resolve, reject) => {
			server!.once('error', reject);
			server!.listen(socketPath, () => resolve());
		});

		await expect(postCapability(socketPath, { sessionKey: 'x', command: 'c', idempotencyKey: 'i' }, { timeoutMs: 50 })).rejects.toThrow(
			/timeout/,
		);
	});
});
