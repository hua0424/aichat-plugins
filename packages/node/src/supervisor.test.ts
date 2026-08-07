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
		// capture each handler's destroy() so teardown tests can assert it was called
		destroyByUid: new Map<number, ReturnType<typeof vi.fn>>(),
		// REQ-008 #76 P2: capture the ws hooks per uid so tests can drive reconnect transitions
		// #184: also capture onAuthError so the handshake-circuit → degrade wiring is testable.
		hooksByUid: new Map<
			number,
			{ onConnected: () => void; onDisconnected: () => void; onAuthError: () => Promise<boolean> }
		>(),
		// REQ-009 #83: capture each api client's reportAgentType per uid so the test can assert
		// onConnected reports the agent type.
		reportAgentTypeByUid: new Map<number, ReturnType<typeof vi.fn>>(),
		// REQ #26 / BL-015 #140: capture each handler's prewarmGroupConfigs per uid so the test can
		// assert onConnected also prewarms group configs (not just reportAgentType).
		prewarmByUid: new Map<number, ReturnType<typeof vi.fn>>(),
		// #188: same capture for prewarmPersona (人设缓存预热，与群配置预热同点触发)。
		prewarmPersonaByUid: new Map<number, ReturnType<typeof vi.fn>>(),
		// #193: capture each api client's reportHostInfo per uid so the test can assert
		// onConnected reports host info (hostname/ip/workspaceBase).
		reportHostInfoByUid: new Map<number, ReturnType<typeof vi.fn>>(),
		// REQ-018: capture each api client's getAgentPromptTemplates (fetched fail-fast in buildAgent).
		getAgentPromptTemplatesByUid: new Map<number, ReturnType<typeof vi.fn>>(),
		// REQ-018: capture each handler's setPromptTemplates (seeded after build) + prewarmPromptTemplates
		// (fired on onConnected, same point as prewarmPersona).
		setPromptTemplatesByUid: new Map<number, ReturnType<typeof vi.fn>>(),
		prewarmPromptTemplatesByUid: new Map<number, ReturnType<typeof vi.fn>>(),
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
		buildApiClient: vi.fn((cred: AichatCredentials): HulaApiClient => {
			const reportAgentType = vi.fn().mockResolvedValue(undefined);
			built.reportAgentTypeByUid.set(cred.uid, reportAgentType);
			const reportHostInfo = vi.fn().mockResolvedValue(undefined);
			built.reportHostInfoByUid.set(cred.uid, reportHostInfo);
			// REQ-018: templates fetched fail-fast in buildAgent (before driver connect).
			const getAgentPromptTemplates = vi
				.fn()
				.mockResolvedValue({ replyContract: 'rc', identityAnchor: 'ia', personaSection: 'ps' });
			built.getAgentPromptTemplatesByUid.set(cred.uid, getAgentPromptTemplates);
			return { reportAgentType, reportHostInfo, getAgentPromptTemplates } as unknown as HulaApiClient;
		}),
		buildWs: vi.fn(
			(
				cred: AichatCredentials,
				hooks: {
					onConnected: () => void;
					onDisconnected: () => void;
					onAuthError: () => Promise<boolean>;
				},
			): HulaWSClient => {
				const connect = vi.fn();
				const close = vi.fn();
				built.wsList.push({ uid: cred.uid, connect, close });
				built.hooksByUid.set(cred.uid, hooks);
				return { connect, close } as unknown as HulaWSClient;
			},
		),
		buildHandler: vi.fn(
			(_ws, _driver, uid: number, _api, onTokenExpired: () => void): MessageHandler => {
				built.tokenExpiredByUid.set(uid, onTokenExpired);
				const destroy = vi.fn();
				built.destroyByUid.set(uid, destroy);
				const prewarmGroupConfigs = vi.fn().mockResolvedValue(undefined);
				built.prewarmByUid.set(uid, prewarmGroupConfigs);
				const prewarmPersona = vi.fn().mockResolvedValue(undefined);
				built.prewarmPersonaByUid.set(uid, prewarmPersona);
				// REQ-018: templates seeded after build (setPromptTemplates) + prewarmed on reconnect.
				const setPromptTemplates = vi.fn();
				built.setPromptTemplatesByUid.set(uid, setPromptTemplates);
				const prewarmPromptTemplates = vi.fn().mockResolvedValue(undefined);
				built.prewarmPromptTemplatesByUid.set(uid, prewarmPromptTemplates);
				return {
					handle: vi.fn(),
					prewarmGroupConfigs,
					prewarmPersona,
					setPromptTemplates,
					prewarmPromptTemplates,
					destroy,
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

	it('#166: starts in PARALLEL yet preserves entries order (pre-sized slots, deterministic)', async () => {
		const completion: number[] = [];
		const { deps } = makeDeps({
			resolveCredential: vi.fn(async (entry: AgentEntry): Promise<AichatCredentials> => {
				const uid = Number(entry.token.replace(/\D/g, '')) || 1;
				// reverse delay: uid 3 finishes first, uid 1 last → completion order != entries order.
				// serial `for…await` would force completion order [1,2,3]; getting [3,2,1] proves concurrency.
				await new Promise((r) => setTimeout(r, (4 - uid) * 15));
				completion.push(uid);
				return { uid, connectionToken: `conn-${uid}`, machineCode: `mc-${uid}`, activatedAt: 'now' };
			}),
		});
		const sup = new Supervisor(deps);
		await sup.start(entries);

		expect(completion).toEqual([3, 2, 1]); // concurrent: finished in reverse-delay order
		expect(sup.agents.map((a) => a.uid)).toEqual([1, 2, 3]); // slots preserve entries order (NOT completion order)
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

describe('Supervisor connect retry (REQ-008 #79)', () => {
	const oneEntry: AgentEntry[] = [{ tool: 'openclaw', token: 'tok-1' }];

	it('transient-then-success: connect rejects "gateway starting" twice then resolves on the 3rd → agent online; 3 builds/connects; 2 delays; failed drivers disconnected', async () => {
		const disconnects: Array<ReturnType<typeof vi.fn>> = [];
		const connects: Array<ReturnType<typeof vi.fn>> = [];
		let attempt = 0;
		const delay = vi.fn(() => Promise.resolve());

		const { deps } = makeDeps({
			buildDriver: vi.fn((): AgentDriver => {
				attempt++;
				const willFail = attempt <= 2;
				const connect = willFail
					? vi.fn().mockRejectedValue(new Error('gateway starting'))
					: vi.fn().mockResolvedValue(undefined);
				const disconnect = vi.fn().mockResolvedValue(undefined);
				connects.push(connect);
				disconnects.push(disconnect);
				return { type: 'mock', connect, disconnect, openSession: vi.fn() } as unknown as AgentDriver;
			}),
			delay,
			maxConnectAttempts: 5,
		});

		const sup = new Supervisor(deps);
		await sup.start(oneEntry);

		expect(sup.agents).toHaveLength(1);
		expect(sup.agents[0].status).toBe('online');
		// 3 attempts: build + connect each
		expect(deps.buildDriver).toHaveBeenCalledTimes(3);
		expect(connects).toHaveLength(3);
		for (const c of connects) expect(c).toHaveBeenCalledOnce();
		// 2 backoff delays
		expect(delay).toHaveBeenCalledTimes(2);
		// the 2 failed drivers were disconnected; the successful one was not
		expect(disconnects[0]).toHaveBeenCalledOnce();
		expect(disconnects[1]).toHaveBeenCalledOnce();
		expect(disconnects[2]).not.toHaveBeenCalled();
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('non-transient connect error → no retry: exactly 1 attempt, agent not online, delay never called', async () => {
		const delay = vi.fn(() => Promise.resolve());
		const { deps } = makeDeps({
			buildDriver: vi.fn(
				(): AgentDriver =>
					({
						type: 'mock',
						connect: vi.fn().mockRejectedValue(new Error('boom')),
						disconnect: vi.fn().mockResolvedValue(undefined),
						openSession: vi.fn(),
					}) as unknown as AgentDriver,
			),
			delay,
			maxConnectAttempts: 5,
		});

		const sup = new Supervisor(deps);
		await expect(sup.start(oneEntry)).resolves.toBeUndefined();

		expect(deps.buildDriver).toHaveBeenCalledTimes(1);
		expect(sup.agents).toHaveLength(0);
		expect(delay).not.toHaveBeenCalled();
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('all-attempts-transient → degrades after maxConnectAttempts without throwing out of start()', async () => {
		const delay = vi.fn(() => Promise.resolve());
		const { deps } = makeDeps({
			buildDriver: vi.fn(
				(): AgentDriver =>
					({
						type: 'mock',
						connect: vi.fn().mockRejectedValue(new Error('gateway starting')),
						disconnect: vi.fn().mockResolvedValue(undefined),
						openSession: vi.fn(),
					}) as unknown as AgentDriver,
			),
			delay,
			maxConnectAttempts: 3,
		});

		const sup = new Supervisor(deps);
		await expect(sup.start(oneEntry)).resolves.toBeUndefined();

		expect(deps.buildDriver).toHaveBeenCalledTimes(3);
		// delays only between attempts: 2 for 3 attempts
		expect(delay).toHaveBeenCalledTimes(2);
		expect(sup.agents).toHaveLength(0);
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

	it('degrade tears down only the target agent handler (destroy called for it, not others)', async () => {
		const { deps, built } = makeDeps();
		const sup = new Supervisor(deps);
		await sup.start(entries);

		// fire onTokenExpired for uid=2
		built.tokenExpiredByUid.get(2)!();

		// target handler destroyed exactly once
		expect(built.destroyByUid.get(2)).toHaveBeenCalledOnce();
		// other agents' handlers NOT destroyed
		expect(built.destroyByUid.get(1)).not.toHaveBeenCalled();
		expect(built.destroyByUid.get(3)).not.toHaveBeenCalled();
		expect(exitSpy).not.toHaveBeenCalled();
	});
});

describe('Supervisor reconnect status (REQ-008 #76 P2)', () => {
	it('onDisconnected → reconnecting; onConnected → back to online', async () => {
		const { deps, built } = makeDeps();
		const sup = new Supervisor(deps);
		await sup.start(entries);

		const agent2 = sup.agents.find((a) => a.uid === 2)!;
		expect(agent2.status).toBe('online');

		const hooks = built.hooksByUid.get(2)!;
		hooks.onDisconnected();
		expect(agent2.status).toBe('reconnecting');

		hooks.onConnected();
		expect(agent2.status).toBe('online');
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('a degraded(offline) agent stays offline across a reconnect callback (offline is terminal)', async () => {
		const { deps, built } = makeDeps();
		const sup = new Supervisor(deps);
		await sup.start(entries);

		// degrade uid=2 via token expiry
		built.tokenExpiredByUid.get(2)!();
		const agent2 = sup.agents.find((a) => a.uid === 2)!;
		expect(agent2.status).toBe('offline');

		// a late reconnect callback must NOT flip it back to online/reconnecting
		const hooks = built.hooksByUid.get(2)!;
		hooks.onDisconnected();
		expect(agent2.status).toBe('offline');
		hooks.onConnected();
		expect(agent2.status).toBe('offline');
		expect(exitSpy).not.toHaveBeenCalled();
	});
});

describe('Supervisor handshake-circuit degrade (#184)', () => {
	it('firing onAuthError (permanent handshake) degrades only the target agent; returns false; no process.exit', async () => {
		const { deps, built } = makeDeps();
		const sup = new Supervisor(deps);
		await sup.start(entries);

		// fire the onAuthError captured for uid=2 (HulaWSClient calls it on a 200+{code:406} circuit)
		const fire = built.hooksByUid.get(2)!.onAuthError;
		expect(fire).toBeTypeOf('function');
		const canRetry = await fire();

		// supervisor's wiring returns false → HulaWSClient will not schedule a post-circuit reconnect
		expect(canRetry).toBe(false);

		const agent2 = sup.agents.find((a) => a.uid === 2)!;
		expect(agent2.status).toBe('offline');
		// degrade tore down this identity's ws + driver
		const ws2 = built.wsList.find((w) => w.uid === 2)!;
		expect(ws2.close).toHaveBeenCalledOnce();
		const driver2 = built.drivers.find((d) => d.entry.token === 'tok-2')!;
		expect(driver2.disconnect).toHaveBeenCalledOnce();

		// others stay online and untouched
		for (const a of sup.agents.filter((a) => a.uid !== 2)) {
			expect(a.status).toBe('online');
		}
		expect(exitSpy).not.toHaveBeenCalled();
	});
});

describe('Supervisor reportAgentType + prewarm on connect (REQ-009 #83 / REQ #26 / BL-015 #140)', () => {
	it('firing onConnected reports the entry tool AND prewarms group configs for that identity', async () => {
		const { deps, built } = makeDeps();
		const sup = new Supervisor(deps);
		await sup.start(entries);

		// uid=2 was built from entry { tool: 'openclaw', token: 'tok-2' }
		const report = built.reportAgentTypeByUid.get(2)!;
		const prewarm = built.prewarmByUid.get(2)!;
		expect(report).toBeTypeOf('function');
		expect(prewarm).toBeTypeOf('function');

		// drive the captured onConnected hook for uid=2
		built.hooksByUid.get(2)!.onConnected();

		// both are fire-and-forget `void retryAsync(...)`; the first attempt runs synchronously up to
		// the first `await fn()`, so `fn` (reportAgentType / prewarmGroupConfigs) is invoked synchronously.
		expect(report).toHaveBeenCalledWith('openclaw');
		expect(prewarm).toHaveBeenCalledTimes(1);
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('#188: firing onConnected also prewarms the persona cache for that identity', async () => {
		const { deps, built } = makeDeps();
		const sup = new Supervisor(deps);
		await sup.start(entries);

		const prewarmPersona = built.prewarmPersonaByUid.get(2)!;
		expect(prewarmPersona).toBeTypeOf('function');

		built.hooksByUid.get(2)!.onConnected();

		expect(prewarmPersona).toHaveBeenCalledTimes(1);
		expect(exitSpy).not.toHaveBeenCalled();
	});
});

describe('Supervisor REQ-018 — fail-fast prompt templates', () => {
	it('getAgentPromptTemplates rejects for one identity → start isolates it (agents=[1,3]), no process.exit', async () => {
		const { deps } = makeDeps({
			buildApiClient: vi.fn((cred: AichatCredentials): HulaApiClient => {
				const getAgentPromptTemplates = vi.fn().mockImplementation(async () => {
					if (cred.uid === 2) throw new Error('agent prompt config unavailable: server 未升级（404）');
					return { replyContract: 'rc', identityAnchor: 'ia', personaSection: 'ps' };
				});
				return { getAgentPromptTemplates } as unknown as HulaApiClient;
			}),
		});
		const sup = new Supervisor(deps);

		// must not throw; the 2nd identity is skipped (templates unfetchable → must NOT come online).
		await expect(sup.start(entries)).resolves.toBeUndefined();

		expect(sup.agents.map((a) => a.uid).sort()).toEqual([1, 3]);
		expect(sup.agents.every((a) => a.status === 'online')).toBe(true);
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('each online identity has its handler seeded with the fetched templates (setPromptTemplates)', async () => {
		const { deps, built } = makeDeps();
		const sup = new Supervisor(deps);
		await sup.start(entries);

		for (const uid of [1, 2, 3]) {
			expect(built.setPromptTemplatesByUid.get(uid)).toHaveBeenCalledWith({
				replyContract: 'rc',
				identityAnchor: 'ia',
				personaSection: 'ps',
			});
		}
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('firing onConnected also calls prewarmPromptTemplates for that identity', async () => {
		const { deps, built } = makeDeps();
		const sup = new Supervisor(deps);
		await sup.start(entries);

		built.hooksByUid.get(2)!.onConnected();

		expect(built.prewarmPromptTemplatesByUid.get(2)).toHaveBeenCalledTimes(1);
		expect(exitSpy).not.toHaveBeenCalled();
	});
});

describe('Supervisor reportHostInfo on connect (#193)', () => {
	const mixedEntries: AgentEntry[] = [
		{ tool: 'openclaw', token: 'tok-1' },
		{ tool: 'opencode', token: 'tok-2' },
		{ tool: 'codex', token: 'tok-3' },
		{ tool: 'cc', token: 'tok-4' },
	];
	const workspaceBaseFor = (entry: AgentEntry): string | undefined =>
		entry.tool === 'opencode'
			? '/base/opencode'
			: entry.tool === 'codex'
				? '/base/codex'
				: entry.tool === 'cc'
					? '/base/cc'
					: undefined;

	it('onConnected reports host info; opencode/codex/cc carry workspaceBase, openclaw omits it', async () => {
		const { deps, built } = makeDeps({ workspaceBaseFor });
		const sup = new Supervisor(deps);
		await sup.start(mixedEntries);

		for (const uid of [1, 2, 3, 4]) {
			built.hooksByUid.get(uid)!.onConnected();
			expect(built.reportHostInfoByUid.get(uid)).toHaveBeenCalledTimes(1);
		}

		const openclawPayload = built.reportHostInfoByUid.get(1)!.mock.calls[0][0] as Record<string, unknown>;
		expect(openclawPayload.hostname).toBeTypeOf('string');
		expect((openclawPayload.hostname as string).length).toBeGreaterThan(0);
		// openclaw 不带 workspaceBase（workspaceBaseFor 返回 undefined → 字段省略）
		expect('workspaceBase' in openclawPayload).toBe(false);

		expect(built.reportHostInfoByUid.get(2)!.mock.calls[0][0]).toMatchObject({
			workspaceBase: '/base/opencode',
		});
		expect(built.reportHostInfoByUid.get(3)!.mock.calls[0][0]).toMatchObject({
			workspaceBase: '/base/codex',
		});
		expect(built.reportHostInfoByUid.get(4)!.mock.calls[0][0]).toMatchObject({
			workspaceBase: '/base/cc',
		});
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('重连（onConnected 二次触发）→ 再次上报', async () => {
		const { deps, built } = makeDeps({ workspaceBaseFor });
		const sup = new Supervisor(deps);
		await sup.start(mixedEntries);

		const hooks = built.hooksByUid.get(2)!;
		hooks.onConnected();
		hooks.onDisconnected();
		hooks.onConnected();

		expect(built.reportHostInfoByUid.get(2)).toHaveBeenCalledTimes(2);
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('workspaceBaseFor 缺省时四类身份统一不带 workspaceBase（可选 dep）', async () => {
		const { deps, built } = makeDeps();
		const sup = new Supervisor(deps);
		await sup.start(mixedEntries);

		built.hooksByUid.get(2)!.onConnected();
		const payload = built.reportHostInfoByUid.get(2)!.mock.calls[0][0] as Record<string, unknown>;
		expect(payload.hostname).toBeTypeOf('string');
		expect('workspaceBase' in payload).toBe(false);
		expect(exitSpy).not.toHaveBeenCalled();
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

	it('destroys every agent handler on stop (timers/sessions must not leak)', async () => {
		const { deps, built } = makeDeps();
		const sup = new Supervisor(deps);
		await sup.start(entries);
		await sup.stop();
		for (const uid of [1, 2, 3]) {
			expect(built.destroyByUid.get(uid)).toHaveBeenCalledOnce();
		}
	});
});
