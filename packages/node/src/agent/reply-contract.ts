/**
 * REQ-010 S1 / ADR-0004 — the single-sourced agent reply contract.
 *
 * Every driver tells the agent the SAME thing: your text output is thinking (never shown to the user);
 * to actually reply you MUST run `aichat send-message --content "…"` in bash; the room + identity are
 * auto-bound (never pass them — anti-spoofing); no reply needed → don't run it. openclaw/opencode/codex
 * each used to inline a byte-identical Chinese prose block; that is now {@link buildReplyInstruction}.
 * cc is launch-prompt-driven with a deliberately different anti-injection wrapper (cc/launch.ts) — it
 * shares only the {@link REPLY_COMMAND} literal so the command string can never drift between drivers.
 */

/** The exact reply CLI the agent must run to send a message (single-sourced so it can't drift). */
export const REPLY_COMMAND = 'aichat send-message --content "<你的回复>"';

/**
 * The per-turn role-instruction prefixed to an inbound message for the NODE-DRIVEN drivers
 * (openclaw / opencode / codex). Byte-identical to the three former inline copies.
 */
export function buildReplyInstruction(message: string): string {
	return (
		'说明：你的正文输出是分析/思考过程，不会直接发给用户。' +
		`要回复用户时，请在 bash 中运行命令 \`${REPLY_COMMAND}\`（参见 aichat 技能）。` +
		'当前会话已自动绑定本聊天的房间与身份，绝不要也无法传 room 或任何身份信息（由系统绑定）。' +
		'若本轮无需回复（如纯客套、无实质内容），不运行该命令即可——本轮自然结束，不会发送任何消息。\n\n' +
		'--- 用户消息如下 ---\n' +
		message
	);
}
