import type { OpenClawPluginApi } from './types.js';
import { hulaChannel } from './channel/index.js';
import { HulaApiClient } from './hula-api.js';
import { registerTools } from './tools/index.js';

/**
 * aichat-claw Plugin 入口
 * 注册 HuLa Channel + Agent Tools
 */
export default function register(api: OpenClawPluginApi) {
	api.logger.info('aichat-claw loading');

	// 注册 HuLa Channel
	api.registerChannel({ plugin: hulaChannel });

	// 创建 HuLa API 客户端并注册 Tools
	const config = api.runtime.config as { hula?: { serverUrl?: string; aiclawToken?: string } };
	const serverUrl = config.hula?.serverUrl || 'http://localhost:18760';
	const aiclawToken = config.hula?.aiclawToken || '';

	if (aiclawToken) {
		const hulaApi = new HulaApiClient(serverUrl, aiclawToken);
		registerTools(api, hulaApi);
		api.logger.info('aichat-claw loaded: channel=hula, tools=hula_find_friend,hula_send_message');
	} else {
		api.logger.warn('aichat-claw: hula.aiclawToken not configured, tools disabled');
		api.logger.info('aichat-claw loaded: channel=hula (tools disabled)');
	}
}
