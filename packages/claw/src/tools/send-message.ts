import { Type } from '@sinclair/typebox';
import type { HulaApiClient } from '../hula-api.js';
import type { AgentTool } from '../types.js';

const schema = {
	type: 'object' as const,
	properties: {
		roomId: Type.Number({ description: '目标房间 ID' }),
		content: Type.String({ description: '消息内容' }),
		extra: Type.Optional(
			Type.Object(
				{},
				{ description: '额外字段（如 { thinkingId: string, autoReply: boolean }），server 侧不入库' }
			)
		),
	},
	required: ['roomId', 'content'],
};

export function createSendMessageTool(api: HulaApiClient): AgentTool {
	return {
		name: 'hula_send_message',
			description: '当你需要回复用户消息时，调用此工具向指定房间发送文本消息。必须在思考完成后调用此工具发送你的回复内容。',
		schema,
		async execute(params: Record<string, unknown>) {
			const roomId = params.roomId as number;
			const content = params.content as string;
			const extra = params.extra as Record<string, unknown> | undefined;

			if (!roomId) {
				return { error: '房间 ID 不能为空' };
			}
			if (!content?.trim()) {
				return { error: '消息内容不能为空' };
			}

			try {
				const result = await api.sendMessage(roomId, content, extra);
				return { ok: true, msgId: result.msgId };
			} catch (err) {
				return { error: err instanceof Error ? err.message : '发送失败' };
			}
		},
	};
}
