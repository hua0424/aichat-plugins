import { Type } from '@sinclair/typebox';
import type { HulaApiClient } from '../hula-api.js';
import type { AgentTool } from '../types.js';

const schema = {
	type: 'object' as const,
	properties: {
		roomId: Type.Number({ description: '目标房间 ID' }),
		content: Type.String({ description: '消息内容' }),
	},
	required: ['roomId', 'content'],
};

export function createSendMessageTool(api: HulaApiClient): AgentTool {
	return {
		name: 'hula_send_message',
		description: '通过 HuLa 向指定房间发送文本消息。需要提供房间 ID 和消息内容。',
		schema,
		async execute(params: Record<string, unknown>) {
			const roomId = params.roomId as number;
			const content = params.content as string;
			if (!roomId) {
				return { error: '房间 ID 不能为空' };
			}
			if (!content?.trim()) {
				return { error: '消息内容不能为空' };
			}
			const result = await api.sendMessage(roomId, content);
			return { ok: true, msgId: result.msgId };
		},
	};
}
