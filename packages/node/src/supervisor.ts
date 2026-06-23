import type { AgentEntry } from './registry.js';
import type { AichatCredentials } from './config.js';
import type { AgentDriver } from './agent/events.js';
import type { HulaWSClient } from './server/hula-ws.js';
import type { HulaApiClient } from './api/hula-api.js';
import type { MessageHandler } from './handler/message.js';

/**
 * REQ-008 #76 — 监督器依赖注入面。
 * 全部副作用（凭证解析 / driver / api / ws / handler 构建）以工厂注入，
 * 使监督器编排逻辑（拉起 / 隔离 / 降级）可纯 mock 单测，无需真实 WS/网络。
 */
export interface SupervisorDeps {
	resolveCredential: (entry: AgentEntry) => Promise<AichatCredentials>;
	buildDriver: (entry: AgentEntry) => AgentDriver;
	buildApiClient: (cred: AichatCredentials) => HulaApiClient;
	buildWs: (
		cred: AichatCredentials,
		hooks: { onMessage: (m: unknown) => void; onConnected: () => void; onDisconnected: () => void },
	) => HulaWSClient;
	buildHandler: (
		ws: HulaWSClient,
		driver: AgentDriver,
		uid: number,
		api: HulaApiClient,
		onTokenExpired: () => void,
	) => MessageHandler;
}

export type AgentStatus = 'online' | 'offline';

/** 一条已拉起（或曾拉起）的身份链路。 */
export interface SupervisedAgent {
	entry: AgentEntry;
	uid: number;
	status: AgentStatus;
	driver: AgentDriver;
	ws: HulaWSClient;
	handler: MessageHandler;
}

/**
 * 多身份监督器。从 N 项注册表拉起 N 条身份链路，每条 = (凭证 + HuLa WS + AgentDriver + MessageHandler)，
 * **per-agent 失败隔离**：任一身份解析/连接抛错只降级该身份，其余照常拉起；token 过期只降级单身份，绝不 process.exit。
 */
export class Supervisor {
	private supervised: SupervisedAgent[] = [];

	constructor(private deps: SupervisorDeps) {}

	get agents(): ReadonlyArray<SupervisedAgent> {
		return this.supervised;
	}

	/**
	 * 顺序拉起每一项（确定性、便于测试）。任一项抛错 → 该身份记为降级并跳过，其余继续。
	 */
	async start(entries: AgentEntry[]): Promise<void> {
		for (const entry of entries) {
			try {
				await this.startAgent(entry);
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				console.error(`[supervisor] agent (tool=${entry.tool}) failed to start, skipped: ${reason}`);
			}
		}
	}

	/**
	 * 拉起单条身份链路。任一步抛错向上冒泡给 start 隔离处理（本身份不进入 supervised online 列表）。
	 */
	private async startAgent(entry: AgentEntry): Promise<void> {
		const cred = await this.deps.resolveCredential(entry);
		const driver = this.deps.buildDriver(entry);
		await driver.connect();
		const api = this.deps.buildApiClient(cred);

		let handler: MessageHandler;
		const ws = this.deps.buildWs(cred, {
			onMessage: (m) => handler.handle(m as never),
			onConnected: () => {
				// REQ #26: 首连 + 每次重连主动预热全量群配置（fire-and-forget，内部已容错）。
				handler.prewarmGroupConfigs().catch(() => {});
			},
			onDisconnected: () => {
				console.log(`[supervisor] agent uid=${cred.uid} disconnected, will auto-reconnect...`);
			},
		});

		handler = this.deps.buildHandler(ws, driver, cred.uid, api, () =>
			this.degrade(cred.uid, 'token expired'),
		);

		ws.connect();

		this.supervised.push({ entry, uid: cred.uid, status: 'online', driver, ws, handler });
		console.log(`[supervisor] agent uid=${cred.uid} (tool=${entry.tool}) online`);
	}

	/**
	 * 降级单条身份：置 offline、关 ws、断 driver。已 offline 则 no-op。
	 * **绝不 process.exit、绝不触碰其它身份。**
	 */
	private degrade(uid: number, reason: string): void {
		const agent = this.supervised.find((a) => a.uid === uid);
		if (!agent || agent.status === 'offline') return;
		agent.status = 'offline';
		void agent.ws.close();
		void agent.driver.disconnect().catch(() => {});
		console.error(`[supervisor] agent uid=${uid} degraded: ${reason}`);
	}

	/**
	 * 关停全部身份（best-effort，逐项 catch 不互相影响）。
	 */
	async stop(): Promise<void> {
		for (const agent of this.supervised) {
			try {
				agent.ws.close();
			} catch {
				/* best-effort */
			}
			try {
				await agent.driver.disconnect();
			} catch {
				/* best-effort */
			}
		}
	}
}
