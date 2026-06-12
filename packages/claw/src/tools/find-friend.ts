import { Type } from '@sinclair/typebox';
import type { AgentTool, ToolContext } from '../types.js';
import type { HulaApiClientPool } from '../hula-api-pool.js';
import { parseSessionKey } from '../session-key.js';

const parameters = {
	type: 'object' as const,
	properties: {
		keyword: Type.String({ description: '搜索关键词（好友名称或备注）' }),
	},
	required: ['keyword'],
};

/**
 * REQ-004 S2: hula_find_friend 工具工厂。
 * 按 ctx.sessionKey 解析出的 aiclawUid 选择发送身份，
 * 保证搜索的是「当前 aiclaw 自己的好友」。
 */
export function createFindFriendTool(pool: HulaApiClientPool, ctx: ToolContext): AgentTool {
	const owner = parseSessionKey(ctx.sessionKey);

	return {
		name: 'hula_find_friend',
		description: '在 HuLa 中搜索好友。输入关键词，返回匹配的好友列表（uid、名称、头像）。',
		parameters,
		async execute(_toolCallId: string, args: Record<string, unknown>) {
			if (!owner) {
				console.warn(`[hula_find_friend] unparseable sessionKey: ${JSON.stringify(ctx.sessionKey)}`);
				return { error: '会话归属无法解析，拒绝搜索' };
			}

			const keyword = args.keyword as string;
			if (!keyword?.trim()) {
				return { error: '关键词不能为空' };
			}

			let client;
			try {
				client = pool.get(owner.aiclawUid);
			} catch (err) {
				console.error(`[hula_find_friend] no client for aiclaw ${owner.aiclawUid}: ${err instanceof Error ? err.message : String(err)}`);
				return { error: '发送身份不可用' };
			}

			try {
				const friends = await client.searchFriends(keyword);
				console.log(`[hula_find_friend] found ${friends.length} results for "${keyword.substring(0, 30)}"`);
				return { friends };
			} catch (err) {
				console.error(`[hula_find_friend] search failed keyword="${keyword.substring(0, 30)}": ${err instanceof Error ? err.message : String(err)}`);
				return { error: err instanceof Error ? err.message : '搜索失败' };
			}
		},
	};
}
