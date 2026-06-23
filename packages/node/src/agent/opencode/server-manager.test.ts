import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpencodeServerManager, type OpencodeServerManagerDeps } from './server-manager.js';
import type { OpencodeClient } from '@opencode-ai/sdk';

function fakeClient(tag: string): OpencodeClient {
	return { __tag: tag } as unknown as OpencodeClient;
}

function makeDeps(overrides?: Partial<OpencodeServerManagerDeps>) {
	let n = 0;
	const closes: Array<() => void> = [];
	const startServer = vi.fn(async () => {
		n++;
		const close = vi.fn();
		closes.push(close);
		return { url: `http://localhost:${4000 + n}`, close };
	});
	const makeClient = vi.fn((baseUrl: string) => fakeClient(baseUrl));
	const deps: OpencodeServerManagerDeps = {
		startServer,
		makeClient,
		requirePassword: false,
		...overrides,
	};
	return { deps, startServer, makeClient, closes };
}

afterEach(() => {
	delete process.env.OPENCODE_SERVER_PASSWORD;
	vi.restoreAllMocks();
});

describe('OpencodeServerManager', () => {
	it('ensureStarted starts exactly once under concurrency', async () => {
		const { deps, startServer } = makeDeps();
		const mgr = new OpencodeServerManager(deps);
		await Promise.all([mgr.ensureStarted(), mgr.ensureStarted(), mgr.ensureStarted()]);
		expect(startServer).toHaveBeenCalledTimes(1);
		expect(mgr.started).toBe(true);
		// a later call is still a no-op
		await mgr.ensureStarted();
		expect(startServer).toHaveBeenCalledTimes(1);
	});

	it('missing OPENCODE_SERVER_PASSWORD throws when required', async () => {
		const { deps, startServer } = makeDeps({ requirePassword: true });
		delete process.env.OPENCODE_SERVER_PASSWORD;
		const mgr = new OpencodeServerManager(deps);
		await expect(mgr.ensureStarted()).rejects.toThrow('OPENCODE_SERVER_PASSWORD must be set');
		expect(startServer).not.toHaveBeenCalled();
	});

	it('with password set + requirePassword, starts normally', async () => {
		process.env.OPENCODE_SERVER_PASSWORD = 'secret';
		const { deps, startServer } = makeDeps({ requirePassword: true });
		const mgr = new OpencodeServerManager(deps);
		await mgr.ensureStarted();
		expect(startServer).toHaveBeenCalledOnce();
	});

	it('getClient before start throws; after start returns the client', async () => {
		const { deps } = makeDeps();
		const mgr = new OpencodeServerManager(deps);
		expect(() => mgr.getClient()).toThrow(/not started/);
		await mgr.ensureStarted();
		expect(mgr.getClient()).toBeTruthy();
	});

	it('restart closes the old server and starts a fresh one', async () => {
		const { deps, startServer, closes } = makeDeps();
		const mgr = new OpencodeServerManager(deps);
		await mgr.ensureStarted();
		const firstUrl = mgr.url;
		await mgr.restart();
		expect(startServer).toHaveBeenCalledTimes(2);
		expect(closes[0]).toHaveBeenCalledOnce();
		expect(mgr.url).not.toBe(firstUrl);
		expect(mgr.started).toBe(true);
	});

	it('stop closes the server and getClient throws afterward', async () => {
		const { deps, closes } = makeDeps();
		const mgr = new OpencodeServerManager(deps);
		await mgr.ensureStarted();
		await mgr.stop();
		expect(closes[0]).toHaveBeenCalledOnce();
		expect(mgr.started).toBe(false);
		expect(() => mgr.getClient()).toThrow(/not started/);
	});
});
