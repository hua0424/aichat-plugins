import { Type } from '@sinclair/typebox';
import type { HulaApiClient } from '../hula-api.js';
import type { AgentTool } from '../types.js';

const parameters = {
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
		parameters,
		async execute(_toolCallId: string, args: Record<string, unknown>) {
			const rawRoomId = args.roomId;
			const roomId = Number(rawRoomId);
			const content = args.content as string;
			const extra = args.extra as Record<string, unknown> | undefined;

			if (!rawRoomId || !Number.isFinite(roomId)) {
				console.warn(`[hula_send_message] invalid roomId: ${JSON.stringify(rawRoomId)}, full args: ${JSON.stringify(args)}`);
				return { error: `房间 ID 无效: ${JSON.stringify(rawRoomId)}` };
			}
			if (!content?.trim()) {
				return { error: '消息内容不能为空' };
			}

			try {
				const result = await api.sendMessage(roomId, content, extra);
				console.log(`[hula_send_message] sent roomId=${roomId} msgId=${result.msgId}`);
				return { ok: true, msgId: result.msgId };
			} catch (err) {
				console.error(`[hula_send_message] send failed roomId=${roomId}: ${err instanceof Error ? err.message : String(err)}`);
				return { error: err instanceof Error ? err.message : '发送失败' };
			}
		},
	};
}
