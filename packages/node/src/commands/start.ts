import { loadConfig, loadCredentials, getServerUrl, detectClawConfig } from '../config.js';
import { HulaWSClient } from '../server/hula-ws.js';
import { MessageHandler } from '../handler/message.js';
import { OpenclawAdapter } from '../claw/openclaw.js';
import { OpenclawDriver } from '../agent/openclaw-driver.js';
import { ClawRouter } from '../router.js';
import { HulaApiClient, restBaseUrlFromWsUrl } from '../api/hula-api.js';

/**
 * aichat start — 读取本地 credentials 自动连接
 */
export async function start(): Promise<void> {
	const config = loadConfig();
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
	const router = new ClawRouter();
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
