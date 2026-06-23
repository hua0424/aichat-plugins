import { join } from 'node:path';
import { loadConfig, loadCredentials, getServerUrl, detectClawConfig, AICHAT_HOME, type AichatConfig } from '../config.js';
import { HulaWSClient } from '../server/hula-ws.js';
import { MessageHandler } from '../handler/message.js';
import { OpenclawAdapter } from '../claw/openclaw.js';
import { OpenclawDriver } from '../agent/openclaw-driver.js';
import { OpencodeDriver } from '../agent/opencode/opencode-driver.js';
import { OpencodeServerManager, defaultServerManagerDeps } from '../agent/opencode/server-manager.js';
import { FileSessionStore } from '../agent/opencode/session-store.js';
import { AgentRouter } from '../router.js';
import { HulaApiClient, restBaseUrlFromWsUrl } from '../api/hula-api.js';
import { loadAgentRegistry, resolveAgentCredential } from '../registry.js';
import { Supervisor } from '../supervisor.js';
import { getMachineCode } from '../auth/machine.js';

/**
 * aichat start — 读取本地配置自动连接。
 * REQ-008 #76: 若 config.agents 非空 → 多身份监督器路径；否则回退既有单身份路径（不回归）。
 */
export async function start(): Promise<void> {
	const config = loadConfig();
	const registry = loadAgentRegistry(config);

	if (registry.length > 0) {
		await startMultiIdentity(config);
		return;
	}

	await startSingleIdentity(config);
}

/**
 * REQ-008 #76 多身份路径：用真实 deps 构建 Supervisor 并拉起 N 条身份链路（per-agent 隔离）。
 */
async function startMultiIdentity(config: AichatConfig): Promise<void> {
	const registry = loadAgentRegistry(config);
	const serverUrl = getServerUrl(config);
	const clawConfig = detectClawConfig(config);
	// 与 activate.ts 同源：ws://host:port/api/ws/ws → http://host:port/api
	const httpBase = serverUrl
		.replace('ws://', 'http://')
		.replace('wss://', 'https://')
		.replace(/\/ws\/ws$/, '');
	const restBaseUrl = restBaseUrlFromWsUrl(serverUrl);

	console.log(`[start] Multi-identity mode: ${registry.length} agent(s)`);
	console.log(`[start] Server: ${serverUrl}`);
	console.log(`[start] Claw Gateway: ${clawConfig.gatewayUrl}`);

	// REQ-008 #77: 单例 opencode server manager——「1 个 server 服务 N 个身份」。
	// 在此构建一次并被所有 opencode 身份的 buildDriver 闭包共享；仅当注册表里真有
	// opencode 身份、且该身份 connect() 时才惰性 ensureStarted（lazy）。
	const opencodeServer = new OpencodeServerManager(defaultServerManagerDeps());
	const opencodeWorkspaceBase = join(AICHAT_HOME, 'opencode', 'workspace');

	const supervisor = new Supervisor({
		resolveCredential: (entry) =>
			resolveAgentCredential(entry, { machineCode: getMachineCode(), httpBase }),
		buildDriver: (entry) => {
			if (entry.tool === 'openclaw') {
				return new OpenclawDriver(new OpenclawAdapter(clawConfig.gatewayUrl, clawConfig.token));
			}
			if (entry.tool === 'opencode') {
				return new OpencodeDriver({
					server: opencodeServer, // 单例：所有 opencode 身份共享同一 server
					workspaceBase: opencodeWorkspaceBase,
					sessionStore: new FileSessionStore(),
					...(entry.model !== undefined ? { model: entry.model } : {}),
				});
			}
			// 未知 tool 抛错使该身份降级，不影响其它身份。
			throw new Error('unsupported agent tool: ' + entry.tool);
		},
		buildApiClient: (cred) => new HulaApiClient(restBaseUrl, cred.connectionToken),
		buildWs: (cred, hooks) =>
			new HulaWSClient({
				url: serverUrl,
				token: cred.connectionToken,
				clientId: cred.machineCode,
				onMessage: hooks.onMessage,
				onConnected: hooks.onConnected,
				onDisconnected: hooks.onDisconnected,
			}),
		buildHandler: (ws, driver, uid, api, onTokenExpired) =>
			new MessageHandler(ws, driver, uid, api, undefined, onTokenExpired),
	});

	await supervisor.start(registry);

	const shutdown = async () => {
		console.log('\n[start] Shutting down...');
		// Stop per-identity supervision first, THEN close the shared opencode server. The
		// singleton server is owned by global shutdown (not by any OpencodeDriver, whose
		// disconnect() is a no-op for isolation). stop() is a safe no-op if it never started.
		await supervisor.stop().catch(() => {});
		await opencodeServer.stop().catch(() => {});
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
}

/**
 * 既有单身份路径（保持行为不变，含 tokenExpired → process.exit(1)）。
 */
async function startSingleIdentity(config: AichatConfig): Promise<void> {
	const credentials = loadCredentials();

	if (!credentials) {
		console.error('[start] No credentials found. Run "aichat activate" first.');
		process.exit(1);
	}

	const serverUrl = getServerUrl(config);
	const clawConfig = detectClawConfig(config);

	console.log(`[start] UID: ${credentials.uid}`);
	console.log(`[start] Server: ${serverUrl}`);
	console.log(`[start] Claw Gateway: ${clawConfig.gatewayUrl}`);
	console.log(`[start] Machine: ${credentials.machineCode}`);

	// 创建路由器并注册驱动（OpenclawDriver 包裹未改动的 OpenclawAdapter WS 引擎）
	const router = new AgentRouter();
	router.register(new OpenclawDriver(new OpenclawAdapter(clawConfig.gatewayUrl, clawConfig.token)));

	// 连接所有驱动
	await router.connectAll();

	// 获取默认驱动
	const driver = router.getDefault()!;

	// REQ-004 M3: 内嵌轻量 HulaApiClient（autoReply / CLI 使用）
	const restBaseUrl = restBaseUrlFromWsUrl(serverUrl);
	const internalApiClient = new HulaApiClient(restBaseUrl, credentials.connectionToken);
	console.log(`[start] REST API: ${restBaseUrl}`);

	// 创建 HuLa WS 客户端
	let handler: MessageHandler;

	const ws = new HulaWSClient({
		url: serverUrl,
		token: credentials.connectionToken,
		clientId: credentials.machineCode,
		onMessage: (msg) => handler.handle(msg),
		onConnected: () => {
			console.log('[start] Connected! Ready to receive messages.');
			// REQ #26: 首连 + 每次重连都主动拉一次全量群配置预热内存 cache
			// （fire-and-forget，不阻塞 ws onopen 后续逻辑；内部已 try/catch 容错）
			handler.prewarmGroupConfigs().catch(() => {});
		},
		onDisconnected: () => {
			console.log('[start] Disconnected, will auto-reconnect...');
		},
	});

	handler = new MessageHandler(ws, driver, credentials.uid, internalApiClient);

	ws.connect();

	// 优雅退出
	const shutdown = () => {
		console.log('\n[start] Shutting down...');
		router.disconnectAll().catch(() => {});
		ws.close();
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
}
