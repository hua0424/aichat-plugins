import type { HulaApiClientPool } from '../hula-api-pool.js';
import type { OpenClawPluginApi } from '../types.js';
import { createFindFriendTool } from './find-friend.js';
import { createSendMessageTool } from './send-message.js';

/**
 * 批量注册所有 HuLa Agent Tools（tool factory 模式）。
 *
 * REQ-004 S2：每个工具以 factory `(ctx) => AgentTool` 形式注册，
 * openclaw 在每次 agent run 前用本次会话的 ctx 调用 factory，
 * factory 据 ctx.sessionKey 解析归属并绑定 roomId / 发送身份。
 */
export function registerTools(api: OpenClawPluginApi, pool: HulaApiClientPool): void {
	api.registerTool((ctx) => createFindFriendTool(pool, ctx));
	api.logger.info('registered tool factory: hula_find_friend');

	api.registerTool((ctx) => createSendMessageTool(pool, ctx));
	api.logger.info('registered tool factory: hula_send_message');
}
