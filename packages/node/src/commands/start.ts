import { loadConfig, loadCredentials, getServerUrl, detectClawConfig } from '../config.js';
import { HulaWSClient } from '../server/hula-ws.js';
import { MessageHandler } from '../handler/message.js';
import { OpenclawAdapter } from '../claw/openclaw.js';
import { ClawRouter } from '../router.js';

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

	// 创建路由器并注册适配器
	const router = new ClawRouter();
	router.register(new OpenclawAdapter(clawConfig.gatewayUrl, clawConfig.token));

	// 连接所有适配器
	await router.connectAll();

	// 获取默认适配器
	const adapter = router.getDefault()!;

	// 创建 HuLa WS 客户端
	let handler: MessageHandler;

	const ws = new HulaWSClient({
		url: serverUrl,
		token: credentials.connectionToken,
		clientId: credentials.machineCode,
		onMessage: (msg) => handler.handle(msg),
		onConnected: () => {
			console.log('[start] Connected! Ready to receive messages.');
		},
		onDisconnected: () => {
			console.log('[start] Disconnected, will auto-reconnect...');
		},
	});

	handler = new MessageHandler(ws, adapter, credentials.uid);

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
