import { loadConfig, loadCredentials, getServerUrl, detectOpenclawConfig } from '../config.js';
import { WSClient } from '../ws/client.js';
import { MessageHandler } from '../handler/message.js';
import { OpenclawEngine } from '../ai/openclaw.js';

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
	const openclawConfig = detectOpenclawConfig(config);

	console.log(`[start] UID: ${credentials.uid}`);
	console.log(`[start] Server: ${serverUrl}`);
	console.log(`[start] OpenClaw: ${openclawConfig.url}`);
	console.log(`[start] Machine: ${credentials.machineCode}`);

	// 初始化 AI 引擎（SSE 流式 Chat Completions API）
	const sessionId = `aichat-${credentials.uid}`;
	const engine = new OpenclawEngine(openclawConfig.url, openclawConfig.token, sessionId);

	// 创建 WS 客户端
	let handler: MessageHandler;

	const ws = new WSClient({
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

	handler = new MessageHandler(ws, engine, credentials.uid);

	ws.connect();

	// 优雅退出
	process.on('SIGINT', () => {
		console.log('\n[start] Shutting down...');
		ws.close();
		process.exit(0);
	});
	process.on('SIGTERM', () => {
		ws.close();
		process.exit(0);
	});
}
