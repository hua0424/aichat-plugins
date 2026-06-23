import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	OpencodeServerManager,
	opencodeBasicAuthHeader,
	type OpencodeServerManagerDeps,
} from './server-manager.js';
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
	delete process.env.OPENCODE_SERVER_START_TIMEOUT_MS;
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

	// REQ-008 #78 — configured pluginPaths flow into config.plugin of the spawned server.
	it('pluginPaths flow into config.plugin passed to startServer', async () => {
		const { deps, startServer } = makeDeps();
		const mgr = new OpencodeServerManager(deps, { pluginPaths: ['/abs/hula-plugin.js'] });
		await mgr.ensureStarted();
		expect(startServer).toHaveBeenCalledOnce();
		const opts = startServer.mock.calls[0][0] as { config?: { plugin?: string[] } };
		expect(opts.config?.plugin).toEqual(['/abs/hula-plugin.js']);
	});

	it('no pluginPaths → startServer gets no config.plugin (empty opts)', async () => {
		const { deps, startServer } = makeDeps();
		const mgr = new OpencodeServerManager(deps);
		await mgr.ensureStarted();
		const opts = startServer.mock.calls[0][0] as { config?: { plugin?: string[] } };
		expect(opts.config).toBeUndefined();
	});

	// REQ-008 — the SDK's default 5000ms start timeout killed every cold start (~6s); the manager
	// must pass a generous timeout to startServer so spawns survive the cold start.
	it('ensureStarted passes a generous default start timeout to startServer', async () => {
		delete process.env.OPENCODE_SERVER_START_TIMEOUT_MS;
		const { deps, startServer } = makeDeps();
		const mgr = new OpencodeServerManager(deps);
		await mgr.ensureStarted();
		const opts = startServer.mock.calls[0][0] as { timeout?: number };
		expect(opts.timeout).toBe(30000);
		expect(opts.timeout).toBeGreaterThanOrEqual(30000);
	});

	it('timeout is also passed alongside config.plugin when pluginPaths are set', async () => {
		const { deps, startServer } = makeDeps();
		const mgr = new OpencodeServerManager(deps, { pluginPaths: ['/abs/hula-plugin.js'] });
		await mgr.ensureStarted();
		const opts = startServer.mock.calls[0][0] as { timeout?: number; config?: { plugin?: string[] } };
		expect(opts.timeout).toBe(30000);
		expect(opts.config?.plugin).toEqual(['/abs/hula-plugin.js']);
	});

	it('OPENCODE_SERVER_START_TIMEOUT_MS overrides the default start timeout', async () => {
		process.env.OPENCODE_SERVER_START_TIMEOUT_MS = '45000';
		try {
			const { deps, startServer } = makeDeps();
			const mgr = new OpencodeServerManager(deps);
			await mgr.ensureStarted();
			const opts = startServer.mock.calls[0][0] as { timeout?: number };
			expect(opts.timeout).toBe(45000);
		} finally {
			delete process.env.OPENCODE_SERVER_START_TIMEOUT_MS;
		}
	});
});

// REQ-008: opencode serve enforces HTTP Basic auth (user "opencode" + OPENCODE_SERVER_PASSWORD).
describe('opencodeBasicAuthHeader', () => {
	it('builds a Basic header for the "opencode" user that decodes back to opencode:<password>', () => {
		const header = opencodeBasicAuthHeader('secret');
		expect(header).toBe('Basic ' + Buffer.from('opencode:secret').toString('base64'));
		const decoded = Buffer.from(header!.slice('Basic '.length), 'base64').toString('utf8');
		expect(decoded).toBe('opencode:secret');
	});

	it('returns undefined when no password is set', () => {
		expect(opencodeBasicAuthHeader(undefined)).toBeUndefined();
		expect(opencodeBasicAuthHeader('')).toBeUndefined();
	});
});
