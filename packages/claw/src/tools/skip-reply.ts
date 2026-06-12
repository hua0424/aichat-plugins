import { Type } from '@sinclair/typebox';
import type { AgentTool, ToolContext } from '../types.js';
import { parseSessionKey } from '../session-key.js';

const parameters = {
	type: 'object' as const,
	properties: {
		reason: Type.Optional(
			Type.String({ description: '跳过回复的原因（可选，便于日志/审计）' })
		),
	},
	required: [] as string[],
};

/**
 * REQ-004 S3: hula_skip_reply 工具工厂。
 *
 * 当本轮没有值得回复的内容时（如纯客套、无实质信息、消息无需回应），
 * 调用此工具作为合法的终结动作——它不发送任何消息，仅向 node 侧表明
 * 「本轮选择跳过」。与 hula_send_message 配对：send 至少一次或 skip 恰好一次
 * 是本轮的合法终结动作。
 *
 * skip 不实际发送任何内容，因此与 send-message 一样无需 roomId 入参，
 * 也不依赖会话归属即可安全返回（解析 sessionKey 仅用于日志一致性）。
 */
export function createSkipReplyTool(ctx: ToolContext): AgentTool {
	const owner = parseSessionKey(ctx.sessionKey);

	return {
		name: 'hula_skip_reply',
		description:
			'当本轮没有值得回复的内容时（例如纯客套寒暄、无实质信息、或该消息不需要回应），调用此工具跳过本次回复。' +
			'它不会发送任何消息。与 hula_send_message 配对使用：要回复就调用 hula_send_message，无需回复就调用本工具。',
		parameters,
		async execute(_toolCallId: string, args: Record<string, unknown>) {
			const reason = args.reason as string | undefined;
			if (!owner) {
				// skip 不发送任何内容，sessionKey 无法解析也无害，照常返回成功
				console.warn(`[hula_skip_reply] unparseable sessionKey: ${JSON.stringify(ctx.sessionKey)} (skip is harmless)`);
			} else {
				console.log(`[hula_skip_reply] skip roomId=${owner.roomId} aiclaw=${owner.aiclawUid} reason=${reason ?? '(none)'}`);
			}
			return { ok: true, skipped: true, reason };
		},
	};
}
