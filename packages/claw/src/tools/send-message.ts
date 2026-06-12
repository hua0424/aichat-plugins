import { Type } from '@sinclair/typebox';
import type { AgentTool, ToolContext } from '../types.js';
import type { HulaApiClientPool } from '../hula-api-pool.js';
import { parseSessionKey } from '../session-key.js';

const parameters = {
	type: 'object' as const,
	properties: {
		content: Type.String({ description: '消息内容' }),
		extra: Type.Optional(
			Type.Object(
				{},
				{ description: '额外字段（如 { thinkingId: string, autoReply: boolean }），server 侧不入库' }
			)
		),
	},
	required: ['content'],
};

/**
 * REQ-004 S2: hula_send_message 工具工厂。
 *
 * roomId 不再作为入参——由 ctx.sessionKey（aiclaw-{uid}-room-{roomId}）解析得出，
 * 通过闭包绑定到 execute，杜绝 agent 自报错误 roomId 打到任意房间。
 * 发送身份（HulaApiClient）按解析出的 aiclawUid 从实例池选择，保证多 aiclaw 归属正确。
 */
export function createSendMessageTool(pool: HulaApiClientPool, ctx: ToolContext): AgentTool {
	const owner = parseSessionKey(ctx.sessionKey);

	return {
		name: 'hula_send_message',
		description: '当你需要回复用户消息时，调用此工具发送文本消息（无需提供房间 ID，系统已绑定当前会话所属房间）。必须在思考完成后调用此工具发送你的回复内容。',
		parameters,
		async execute(_toolCallId: string, args: Record<string, unknown>) {
			if (!owner) {
				console.warn(`[hula_send_message] unparseable sessionKey: ${JSON.stringify(ctx.sessionKey)}`);
				return { error: '会话归属无法解析，拒绝发送' };
			}

			const content = args.content as string;
			const extra = args.extra as Record<string, unknown> | undefined;

			if (!content?.trim()) {
				return { error: '消息内容不能为空' };
			}

			let client;
			try {
				client = pool.get(owner.aiclawUid);
			} catch (err) {
				console.error(`[hula_send_message] no client for aiclaw ${owner.aiclawUid}: ${err instanceof Error ? err.message : String(err)}`);
				return { error: '发送身份不可用' };
			}

			try {
				const result = await client.sendMessage(owner.roomId, content, extra);
				console.log(`[hula_send_message] sent roomId=${owner.roomId} aiclaw=${owner.aiclawUid} msgId=${result.msgId}`);
				return { ok: true, msgId: result.msgId };
			} catch (err) {
				console.error(`[hula_send_message] send failed roomId=${owner.roomId}: ${err instanceof Error ? err.message : String(err)}`);
				return { error: err instanceof Error ? err.message : '发送失败' };
			}
		},
	};
}
