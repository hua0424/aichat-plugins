import type { AgentEntry } from './registry.js';
import type { AichatCredentials } from './config.js';
import type { AgentDriver } from './agent/events.js';
import type { HulaWSClient } from './server/hula-ws.js';
import type { HulaApiClient } from './api/hula-api.js';
import type { MessageHandler } from './handler/message.js';
import { retryAsync } from './util/retry.js';

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
		uid: string,
		api: HulaApiClient,
		onTokenExpired: () => void,
	) => MessageHandler;
	/**
	 * REQ-008 #79：driver.connect() 的瞬态失败重试上限（含首次）。生产缺省 5。测试可注入小值。
	 */
	maxConnectAttempts?: number;
	/**
	 * 第 attempt 次（1-based）失败后的退避毫秒。生产缺省指数退避（封顶 8s）。
	 */
	connectBackoffMs?: (attempt: number) => number;
	/**
	 * 可注入的 sleep（测试注入 `() => Promise.resolve()` 跳过真实等待）。缺省基于 setTimeout。
	 */
	delay?: (ms: number) => Promise<void>;
	/**
	 * 可覆盖的瞬态错误分类器。缺省按错误消息正则匹配（gateway starting / unavailable / 超时 等）。
	 */
	isTransientConnectError?: (err: unknown) => boolean;
}

/** 生产缺省：指数退避，封顶 8s。第 1 次失败等 1s、第 2 次 2s、第 3 次 4s、第 4+ 次 8s。 */
const defaultConnectBackoffMs = (attempt: number): number => Math.min(1000 * 2 ** (attempt - 1), 8000);

/** 生产缺省 sleep。 */
const defaultDelay = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

/**
 * REQ-008 #79：判断 driver.connect() 失败是否为**瞬态**（可重试）。
 * 容器启动时 openclaw gateway 约 5s 才就绪，supervisor 约 2s 即连 → 拿到
 * `[UNAVAILABLE] gateway starting; retry shortly`。这类应退避重试；
 * 「已激活」等不可恢复错误不走 connect 路径（resolveCredential 阶段就抛，不在此重试）。
 */
function defaultIsTransientConnectError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return /gateway starting|unavailable|econnrefused|timeout|starting|temporarily/i.test(msg);
}

/**
 * 身份链路状态。
 * - 'online'：已连上、正常服务。
 * - 'reconnecting'（REQ-008 #76 P2）：HuLa WS 掉线、HulaWSClient 正在自动重连中（瞬态）。
 * - 'offline'：被降级（token 过期 / 启动失败 / stop）。**terminal**：一旦 offline，
 *   迟到的重连回调不得把它翻回 online（degrade 已断 ws/driver，链路不可复活）。
 */
export type AgentStatus = 'online' | 'reconnecting' | 'offline';

/** 一条已拉起（或曾拉起）的身份链路。 */
export interface SupervisedAgent {
	entry: AgentEntry;
	// REQ-029 (#29): uid is an opaque string end-to-end.
	uid: string;
	status: AgentStatus;
	driver: AgentDriver;
	ws: HulaWSClient;
	handler: MessageHandler;
	/**
	 * REQ-010 S1: the per-identity HulaApiClient. The capability endpoint's resolve() uses it to
	 * send a reply to THIS identity's bound room — room/identity never come from the CLI args.
	 */
	api: HulaApiClient;
}

/**
 * 多身份监督器。从 N 项注册表拉起 N 条身份链路，每条 = (凭证 + HuLa WS + AgentDriver + MessageHandler)，
 * **per-agent 失败隔离**：任一身份解析/连接抛错只降级该身份，其余照常拉起；token 过期只降级单身份，绝不 process.exit。
 *
 * **职责边界（scope boundary）**：
 *
 * 本类**负责**：
 * - 编排：从注册表把 N 个身份逐项拉起（确定性顺序）；
 * - per-agent 失败隔离：任一身份解析/连接抛错只降级该身份，其余照常拉起；
 * - per-agent token 过期降级：单身份 token 过期只降级该身份，绝不 process.exit；
 * - 依赖既有的**每连接 HuLa WS 自动重连**（由 HulaWSClient 自行负责），本类不重复实现。
 *
 * 本类**不负责**：
 * - 跨 agent 的健康监控 / 重启循环（不轮询、不主动复活已降级身份）；
 * - agent 运行时（如 opencode server）的重启——那是 driver 的职责
 *   （opencode 自身 server 崩溃/重启在 #77 处理）。
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
		// resolveCredential 的失败（如「已激活」不可恢复）**不是瞬态**，绝不重试 → 直接冒泡降级。
		const cred = await this.deps.resolveCredential(entry);
		const driver = await this.connectWithRetry(entry);
		const api = this.deps.buildApiClient(cred);

		// 显式持有 handler，避免 ws hooks 闭包引用尚未赋值的绑定（移除时序耦合）。
		// onMessage/onConnected 只在 ws.connect() 之后才会触发，此时 ref.handler 必已就绪。
		const ref: { handler: MessageHandler | null } = { handler: null };
		const ws = this.deps.buildWs(cred, {
			onMessage: (m) => ref.handler?.handle(m as never),
			onConnected: () => {
				// REQ-008 #76 P2: 重连成功 → 回到 online。**但 offline 是 terminal**：
				// 已降级身份的迟到重连回调不得翻回 online（degrade 已断 ws/driver）。
				this.markReconnected(cred.uid);
				// REQ #26 / BL-015 #140: 首连 + 每次重连主动预热全量群配置。Nacos 重注册窗口内会失败，
				// 交给 retryAsync 有界退避重试自愈（fire-and-forget，永不 reject，不阻塞 onopen）。
				// handler 在 onConnected 触发前必已就绪（见 ref 注释），故此处非空断言安全。
				void retryAsync(() => ref.handler!.prewarmGroupConfigs(), { label: 'prewarm' });
				// REQ-009 #83 / BL-015 #140: 连接成功后上报 agent 类型。每次连接（含重连）都报，
				// server upsert 幂等；同样带退避重试熬过 Nacos 重注册窗口。
				void retryAsync(() => api.reportAgentType(entry.tool), { label: 'reportAgentType' });
			},
			onDisconnected: () => {
				// REQ-008 #76 P2: 掉线 → reconnecting（瞬态，HulaWSClient 自行重连）。
				// 同样 offline-terminal 守卫：降级身份不进入 reconnecting。
				this.markReconnecting(cred.uid);
				console.log(`[supervisor] agent uid=${cred.uid} disconnected, will auto-reconnect...`);
			},
		});

		ref.handler = this.deps.buildHandler(ws, driver, cred.uid, api, () =>
			this.degrade(cred.uid, 'token expired'),
		);

		ws.connect();

		this.supervised.push({ entry, uid: cred.uid, status: 'online', driver, ws, handler: ref.handler, api });
		console.log(`[supervisor] agent uid=${cred.uid} (tool=${entry.tool}) online`);
	}

	/**
	 * REQ-008 #79：带退避重试地连上 driver。
	 *
	 * 容器启动时 openclaw gateway 约 5s 才就绪，而 supervisor 约 2s 即拉起 → driver.connect()
	 * 可能拿到 `[UNAVAILABLE] gateway starting; retry shortly`。旧单身份路径靠整进程崩溃+重启熬过，
	 * 但本类 per-agent 隔离会把这种**可恢复**瞬态错当永久失败吞掉 → 该身份被无谓降级。
	 *
	 * 策略：最多 maxConnectAttempts 次，每次都 **buildDriver 一个全新 driver** 再 connect()；
	 * 失败时 best-effort disconnect 旧 driver（避免其内部重连定时器泄漏），瞬态且还有次数则退避后重试，
	 * 否则向上抛（让 start 像以前一样降级该身份）。
	 */
	private async connectWithRetry(entry: AgentEntry): Promise<AgentDriver> {
		const maxAttempts = this.deps.maxConnectAttempts ?? 5;
		const backoffMs = this.deps.connectBackoffMs ?? defaultConnectBackoffMs;
		const delay = this.deps.delay ?? defaultDelay;
		const isTransient = this.deps.isTransientConnectError ?? defaultIsTransientConnectError;

		let lastErr: unknown;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			const driver = this.deps.buildDriver(entry);
			try {
				await driver.connect();
				return driver;
			} catch (err) {
				lastErr = err;
				// 清理失败的 driver，避免其内部重连定时器泄漏。
				await driver.disconnect().catch(() => {});
				if (isTransient(err) && attempt < maxAttempts) {
					const reason = err instanceof Error ? err.message : String(err);
					console.error(
						`[supervisor] agent (tool=${entry.tool}) connect attempt ${attempt}/${maxAttempts} failed (transient): ${reason}; retrying...`,
					);
					await delay(backoffMs(attempt));
					continue;
				}
				throw err;
			}
		}
		// 仅当 maxAttempts<1（非常规配置）时到达；保底抛出最后一次错误。
		throw lastErr ?? new Error('connectWithRetry: no attempts made');
	}

	/**
	 * 降级单条身份：置 offline、关 ws、断 driver。已 offline 则 no-op。
	 * **绝不 process.exit、绝不触碰其它身份。**
	 */
	private degrade(uid: string, reason: string): void {
		const agent = this.supervised.find((a) => a.uid === uid);
		if (!agent || agent.status === 'offline') return;
		agent.status = 'offline';
		// best-effort 收尾 handler：清理 active thinking session + 定时器（避免泄漏）。
		try {
			agent.handler.destroy();
		} catch {
			/* best-effort */
		}
		void agent.ws.close();
		void agent.driver.disconnect().catch(() => {});
		console.error(`[supervisor] agent uid=${uid} degraded: ${reason}`);
	}

	/**
	 * REQ-008 #76 P2: WS 掉线 → 置 reconnecting（瞬态）。
	 * **offline 是 terminal**：已降级身份保持 offline，不进入 reconnecting。
	 */
	private markReconnecting(uid: string): void {
		const agent = this.supervised.find((a) => a.uid === uid);
		if (!agent || agent.status === 'offline') return;
		agent.status = 'reconnecting';
	}

	/**
	 * REQ-008 #76 P2: WS 重连成功 → 回到 online。
	 * **offline 是 terminal**：迟到的重连回调不得把已降级身份翻回 online。
	 */
	private markReconnected(uid: string): void {
		const agent = this.supervised.find((a) => a.uid === uid);
		if (!agent || agent.status === 'offline') return;
		agent.status = 'online';
	}

	/**
	 * 关停全部身份（best-effort，逐项 catch 不互相影响）。
	 */
	async stop(): Promise<void> {
		for (const agent of this.supervised) {
			// 先收尾 handler（清理 active thinking session + 定时器，避免泄漏），再关 ws。
			try {
				agent.handler.destroy();
			} catch {
				/* best-effort */
			}
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
