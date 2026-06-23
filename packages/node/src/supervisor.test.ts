import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Supervisor, type SupervisorDeps } from './supervisor.js';
import type { AgentEntry } from './registry.js';
import type { AichatCredentials } from './config.js';
import type { AgentDriver } from './agent/events.js';
import type { HulaWSClient } from './server/hula-ws.js';
import type { HulaApiClient } from './api/hula-api.js';
import type { MessageHandler } from './handler/message.js';

/**
 * Mock factory bundle. Each builder returns a vi.fn-instrumented stub and records
 * what it built so the test can assert isolation + degrade behavior without any
 * real WS / driver / network.
 */
function makeDeps(overrides?: Partial<SupervisorDeps>) {
	const built = {
		drivers: [] as Array<{ entry: AgentEntry; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }>,
		wsList: [] as Array<{ uid: number; connect: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>,
		// capture the onTokenExpired handed to each handler so the test can fire it
		tokenExpiredByUid: new Map<number, () => void>(),
	};

	const deps: SupervisorDeps = {
		resolveCredential: vi.fn(async (entry: AgentEntry): Promise<AichatCredentials> => {
			// uid derived from token suffix for deterministic identity
			const uid = Number(entry.token.replace(/\D/g, '')) || 1;
			return { uid, connectionToken: `conn-${uid}`, machineCode: `mc-${uid}`, activatedAt: 'now' };
		}),
		buildDriver: vi.fn((entry: AgentEntry): AgentDriver => {
			const connect = vi.fn().mockResolvedValue(undefined);
			const disconnect = vi.fn().mockResolvedValue(undefined);
			built.drivers.push({ entry, connect, disconnect });
			return {
				type: 'mock',
				connect,
				disconnect,
				openSession: vi.fn(),
			} as unknown as AgentDriver;
		}),
		buildApiClient: vi.fn((): HulaApiClient => ({}) as unknown as HulaApiClient),
		buildWs: vi.fn((cred: AichatCredentials): HulaWSClient => {
			const connect = vi.fn();
			const close = vi.fn();
			built.wsList.push({ uid: cred.uid, connect, close });
			return { connect, close } as unknown as HulaWSClient;
		}),
		buildHandler: vi.fn(
			(_ws, _driver, uid: number, _api, onTokenExpired: () => void): MessageHandler => {
				built.tokenExpiredByUid.set(uid, onTokenExpired);
				return {
					handle: vi.fn(),
					prewarmGroupConfigs: vi.fn().mockResolvedValue(undefined),
				} as unknown as MessageHandler;
			},
		),
		...overrides,
	};

	return { deps, built };
}

const entries: AgentEntry[] = [
	{ tool: 'openclaw', token: 'tok-1' },
	{ tool: 'openclaw', token: 'tok-2' },
	{ tool: 'openclaw', token: 'tok-3' },
];

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	// Guard: if any path were to call process.exit, fail loudly instead of killing vitest.
	exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
		throw new Error(`process.exit(${code}) was called`);
	}) as never);
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('Supervisor.start', () => {
	it('brings up all 3 agents online; each driver.connect + ws.connect called once; each handler built', async () => {
		const { deps, built } = makeDeps();
		const sup = new Supervisor(deps);
		await sup.start(entries);

		expect(sup.agents).toHaveLength(3);
		expect(sup.agents.every((a) => a.status === 'online')).toBe(true);
		expect(sup.agents.map((a) => a.uid).sort()).toEqual([1, 2, 3]);

		for (const d of built.drivers) {
			expect(d.connect).toHaveBeenCalledOnce();
		}
		for (const w of built.wsList) {
			expect(w.connect).toHaveBeenCalledOnce();
		}
		expect(deps.buildHandler).toHaveBeenCalledTimes(3);
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('ISOLATION: the 2nd entry failing does not block the other two', async () => {
		const { deps } = makeDeps({
			resolveCredential: vi.fn(async (entry: AgentEntry): Promise<AichatCredentials> => {
				if (entry.token === 'tok-2') throw new Error('resolve boom');
				const uid = Number(entry.token.replace(/\D/g, ''));
				return { uid, connectionToken: `conn-${uid}`, machineCode: `mc-${uid}`, activatedAt: 'now' };
			}),
		});
		const sup = new Supervisor(deps);

		// must not throw
		await expect(sup.start(entries)).resolves.toBeUndefined();

		const uids = sup.agents.map((a) => a.uid).sort();
		expect(uids).toEqual([1, 3]);
		expect(sup.agents.every((a) => a.status === 'online')).toBe(true);
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('ISOLATION: a driver.connect() throw for one entry isolates only that entry', async () => {
		const { deps } = makeDeps({
			buildDriver: vi.fn((entry: AgentEntry): AgentDriver => {
				const fail = entry.token === 'tok-2';
				return {
					type: 'mock',
					connect: fail
						? vi.fn().mockRejectedValue(new Error('connect boom'))
						: vi.fn().mockResolvedValue(undefined),
					disconnect: vi.fn().mockResolvedValue(undefined),
					openSession: vi.fn(),
				} as unknown as AgentDriver;
			}),
		});
		const sup = new Supervisor(deps);
		await expect(sup.start(entries)).resolves.toBeUndefined();
		expect(sup.agents.map((a) => a.uid).sort()).toEqual([1, 3]);
		expect(exitSpy).not.toHaveBeenCalled();
	});
});

describe('Supervisor token-expiry degrade', () => {
	it('firing onTokenExpired degrades only the target agent; others stay online; no process.exit', async () => {
		const { deps, built } = makeDeps();
		const sup = new Supervisor(deps);
		await sup.start(entries);

		// fire the onTokenExpired captured for uid=2
		const fire = built.tokenExpiredByUid.get(2)!;
		expect(fire).toBeTypeOf('function');
		fire();

		const agent2 = sup.agents.find((a) => a.uid === 2)!;
		expect(agent2.status).toBe('offline');
		// target's ws.close + driver.disconnect were called
		const ws2 = built.wsList.find((w) => w.uid === 2)!;
		expect(ws2.close).toHaveBeenCalledOnce();
		const driver2 = built.drivers.find((d) => d.entry.token === 'tok-2')!;
		expect(driver2.disconnect).toHaveBeenCalledOnce();

		// others stay online and untouched
		for (const a of sup.agents.filter((a) => a.uid !== 2)) {
			expect(a.status).toBe('online');
		}
		const ws1 = built.wsList.find((w) => w.uid === 1)!;
		const ws3 = built.wsList.find((w) => w.uid === 3)!;
		expect(ws1.close).not.toHaveBeenCalled();
		expect(ws3.close).not.toHaveBeenCalled();

		// process.exit NOT called
		expect(exitSpy).not.toHaveBeenCalled();

		// idempotent: firing again is a no-op (no second close)
		fire();
		expect(ws2.close).toHaveBeenCalledOnce();
	});
});

describe('Supervisor.stop', () => {
	it('closes all ws and disconnects all drivers best-effort', async () => {
		const { deps, built } = makeDeps();
		const sup = new Supervisor(deps);
		await sup.start(entries);
		await sup.stop();
		for (const w of built.wsList) expect(w.close).toHaveBeenCalled();
		for (const d of built.drivers) expect(d.disconnect).toHaveBeenCalled();
	});
});
