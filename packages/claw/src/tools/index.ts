import type { HulaApiClient } from '../hula-api.js';
import type { OpenClawPluginApi } from '../types.js';
import { createFindFriendTool } from './find-friend.js';
import { createSendMessageTool } from './send-message.js';

/**
 * 批量注册所有 HuLa Agent Tools
 */
export function registerTools(api: OpenClawPluginApi, hulaApi: HulaApiClient): void {
	const tools = [
		createFindFriendTool(hulaApi),
		createSendMessageTool(hulaApi),
	];

	for (const tool of tools) {
		api.registerTool(tool);
		api.logger.info(`registered tool: ${tool.name}`);
	}
}
