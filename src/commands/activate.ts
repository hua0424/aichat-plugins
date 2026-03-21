import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { AICHAT_HOME, CREDENTIALS_PATH, CONFIG_PATH, loadConfig, getServerUrl, detectOpenclawConfig } from '../config.js';
import { getMachineCode } from '../auth/machine.js';

/**
 * aichat activate --backend openclaw --token <activation-token>
 * 1. 调用 server /api/im/aiclaw/anyTenant/activate
 * 2. 保存 credentials.jsonc
 * 3. 自动检测 openclaw 配置
 */
export async function activate(activationToken: string, backend: string): Promise<void> {
	// 确保 ~/.aichat 目录存在
	if (!existsSync(AICHAT_HOME)) {
		mkdirSync(AICHAT_HOME, { recursive: true });
	}

	const config = loadConfig();
	const machineCode = getMachineCode();

	// server 地址：config.jsonc > 默认值，WS 地址转为 HTTP
	const wsUrl = getServerUrl(config);
	// ws://host:port/api/ws/ws → http://host:port/api
	const httpBase = wsUrl
		.replace('ws://', 'http://')
		.replace('wss://', 'https://')
		.replace(/\/ws\/ws$/, '');

	console.log(`[activate] Server: ${httpBase}`);
	console.log(`[activate] Machine code: ${machineCode}`);
	console.log(`[activate] Activating...`);

	// 调用 activate API
	const resp = await fetch(`${httpBase}/im/aiclaw/anyTenant/activate`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			activationToken,
			machineCode,
		}),
	});

	const result = await resp.json() as { success: boolean; data?: { uid: number; connectionToken: string }; msg?: string };

	if (!result.success || !result.data) {
		console.error(`[activate] Failed: ${result.msg || 'Unknown error'}`);
		process.exit(1);
	}

	const { uid, connectionToken } = result.data;

	// 保存 credentials
	const credentials = {
		uid,
		connectionToken,
		machineCode,
		activatedAt: new Date().toISOString(),
	};
	writeFileSync(CREDENTIALS_PATH, JSON.stringify(credentials, null, 2), 'utf-8');
	console.log(`[activate] Credentials saved to ${CREDENTIALS_PATH}`);

	// 自动检测 openclaw 配置并写入 config.jsonc（如果还没有）
	if (backend === 'openclaw' && !config.openclaw?.url) {
		const detected = detectOpenclawConfig(config);
		if (detected.url) {
			const newConfig = {
				...config,
				server: { url: wsUrl },
				openclaw: {
					url: detected.url,
					token: detected.token,
					agentId: detected.agentId,
				},
			};
			writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2), 'utf-8');
			console.log(`[activate] Config saved to ${CONFIG_PATH}`);
		}
	}

	console.log(`\n✓ Activated successfully!`);
	console.log(`  UID: ${uid}`);
	console.log(`  Run 'aichat start' to connect.\n`);
}
