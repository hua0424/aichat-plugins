import { Type } from '@sinclair/typebox';
import type { HulaApiClient } from '../hula-api.js';
import type { AgentTool } from '../types.js';

const parameters = {
	type: 'object' as const,
	properties: {
		keyword: Type.String({ description: '搜索关键词（好友名称或备注）' }),
	},
	required: ['keyword'],
};

export function createFindFriendTool(api: HulaApiClient): AgentTool {
	return {
		name: 'hula_find_friend',
		description: '在 HuLa 中搜索好友。输入关键词，返回匹配的好友列表（uid、名称、头像）。',
		parameters,
		async execute(params: Record<string, unknown>) {
			const keyword = params.keyword as string;
			if (!keyword?.trim()) {
				return { error: '关键词不能为空' };
			}
			const friends = await api.searchFriends(keyword);
			return { friends };
		},
	};
}
