import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { postCapability } from './client.js';

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
		const socketPath = join(base, 'hung.sock');

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
