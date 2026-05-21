import type { OpenClawPluginApi, ChannelPlugin } from './types.js';
import { hulaChannel } from './channel/index.js';
import { HulaApiClientPool } from './hula-api-pool.js';
import { registerTools } from './tools/index.js';

/**
 * 从多个可能的路径读取 hula 配置（兼容不同 openclaw 版本的 config 传递方式）
 */
function resolveHulaConfig(
	runtimeConfig: Record<string, unknown>
): { serverUrl?: string; aiclawToken?: string; tokens?: Record<string, string> } {
	// 路径 1: runtime.config.hula（标准路径）
	const direct = runtimeConfig.hula as Record<string, unknown> | undefined;
	if (direct?.aiclawToken || direct?.serverUrl) {
		return {
			serverUrl: direct.serverUrl as string | undefined,
			aiclawToken: direct.aiclawToken as string | undefined,
			tokens: direct.tokens as Record<string, string> | undefined,
		};
	}

	// 路径 2: runtime.config.plugins.entries.aichat-claw.config.hula（某些 openclaw 版本）
	const plugins = runtimeConfig.plugins as Record<string, unknown> | undefined;
	const entries = plugins?.entries as Record<string, unknown> | undefined;
	const pluginConfig = entries?.['aichat-claw'] as Record<string, unknown> | undefined;
	const nestedHula = pluginConfig?.config as Record<string, unknown> | undefined;
	if (nestedHula?.hula) {
		const h = nestedHula.hula as Record<string, unknown>;
		return {
			serverUrl: h.serverUrl as string | undefined,
			aiclawToken: h.aiclawToken as string | undefined,
			tokens: h.tokens as Record<string, string> | undefined,
		};
	}

	// 路径 3: runtime.config 直接就是 hula 对象（fallback）
	if (runtimeConfig.aiclawToken || runtimeConfig.serverUrl) {
		return {
			serverUrl: runtimeConfig.serverUrl as string | undefined,
			aiclawToken: runtimeConfig.aiclawToken as string | undefined,
			tokens: runtimeConfig.tokens as Record<string, string> | undefined,
		};
	}

	return {};
}

/**
 * aichat-claw Plugin 入口
 * 注册 HuLa Channel + Agent Tools
 *
 * REQ-004: 使用 HulaApiClientPool 支持多 aiclaw 独立 token（方案 B 保底）
 */
export default function register(api: OpenClawPluginApi) {
	api.logger.info('aichat-claw loading');

	// DEBUG: 输出 runtime.config 完整结构，帮助诊断 config 传递问题
	api.logger.info('runtime.config keys: ' + Object.keys(api.runtime.config || {}).join(', '));
	// DEBUG: 输出 runtime.config 完整结构，敏感字段脱敏
	const configForLog = JSON.stringify(
		api.runtime.config || {},
		(key, value) => (/token|password|secret|key/i.test(key) && typeof value === 'string') ? '***' : value,
		2
	);
	api.logger.info('runtime.config: ' + configForLog);

	// 多路径解析 hula 配置
	const hulaConfig = resolveHulaConfig(api.runtime.config || {});
	let serverUrl = hulaConfig.serverUrl || 'http://localhost:18760';
	let aiclawToken = hulaConfig.aiclawToken || '';

	// 环境变量 fallback（容器部署时最可靠）
	if (!aiclawToken) {
		aiclawToken = process.env.HULA_AICLAW_TOKEN || '';
		if (aiclawToken) {
			api.logger.info('aichat-claw: using HULA_AICLAW_TOKEN from env');
		}
	}
	if (!serverUrl || serverUrl === 'http://localhost:18760') {
		const envUrl = process.env.HULA_SERVER_URL;
		if (envUrl) {
			serverUrl = envUrl;
			api.logger.info('aichat-claw: using HULA_SERVER_URL from env');
		}
	}

	api.logger.info(`aichat-claw: resolved serverUrl=${serverUrl}, token=${aiclawToken ? '***' : '(empty)'}`);

	const pool = new HulaApiClientPool(serverUrl);

	// 注册 HuLa Channel（带 outbound adapter，支持 agent 直接发送消息）
	const channel: ChannelPlugin = {
		...hulaChannel,
		outbound: {
			async sendText(params) {
				const client = pool.get();
				if (!client) {
					return { ok: false, error: 'HulaApiClient not available' };
				}
				try {
					await client.sendMessage(Number(params.to), params.text);
					return { ok: true };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},
	};
	api.registerChannel({ plugin: channel });

	if (aiclawToken) {
		// 向后兼容：全局 token 作为默认客户端
		pool.setDefault(aiclawToken);

		// REQ-004: 若配置中存在多 aiclaw token 映射，注册到实例池
		const tokens = hulaConfig.tokens;
		if (tokens) {
			for (const [uid, token] of Object.entries(tokens)) {
				pool.register(uid, token);
				api.logger.info(`aichat-claw: registered client for aiclaw ${uid}`);
			}
		}

		// 使用默认客户端注册 Tools（当前 execute 无 context，无法动态选择）
		registerTools(api, pool.get());
		api.logger.info('aichat-claw loaded: channel=hula, tools=hula_find_friend,hula_send_message');
	} else {
		api.logger.warn('aichat-claw: hula.aiclawToken not configured, tools disabled');
		api.logger.info('aichat-claw loaded: channel=hula (tools disabled)');
	}
}
