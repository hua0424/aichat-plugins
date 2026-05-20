import type { OpenClawPluginApi } from './types.js';
import { hulaChannel } from './channel/index.js';
import { HulaApiClientPool } from './hula-api-pool.js';
import { registerTools } from './tools/index.js';

/**
 * aichat-claw Plugin 入口
 * 注册 HuLa Channel + Agent Tools
 *
 * REQ-004: 使用 HulaApiClientPool 支持多 aiclaw 独立 token（方案 B 保底）
 */
export default function register(api: OpenClawPluginApi) {
	api.logger.info('aichat-claw loading');

	// 注册 HuLa Channel
	api.registerChannel({ plugin: hulaChannel });

	// 创建 API 客户端池
	const config = api.runtime.config as { hula?: { serverUrl?: string; aiclawToken?: string } };
	const serverUrl = config.hula?.serverUrl || 'http://localhost:18760';
	const aiclawToken = config.hula?.aiclawToken || '';

	const pool = new HulaApiClientPool(serverUrl);

	if (aiclawToken) {
		// 向后兼容：全局 token 作为默认客户端
		pool.setDefault(aiclawToken);

		// REQ-004: 若配置中存在多 aiclaw token 映射，注册到实例池
		const tokens = (config.hula as Record<string, unknown> | undefined)?.tokens as
			| Record<string, string>
			| undefined;
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
