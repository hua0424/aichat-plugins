import { type Plugin, tool } from '@opencode-ai/plugin';

/**
 * REQ-008 #78 — opencode plugin shim (THIN tool-declaration only).
 *
 * This module is loaded by the spawned opencode server (via `config.plugin`) ONLY so the
 * agent can CALL the terminal tools `hula_send_message` / `hula_skip_reply`. It performs
 * NO network and NO callback into aichat-node: `execute()` just returns a confirmation
 * string. The REAL reply is sent by aichat-node, which reads the completed tool's
 * `state.input` off the SSE stream (the tool args land there), emits a `terminal`
 * AgentEvent carrying `content`, and sends it via the per-identity HulaApiClient to the
 * session's BOUND roomId. Identity/room come ONLY from the session binding — never from
 * tool args (anti-spoofing). See agent/opencode/events.ts + handler/message.ts.
 */
export const HulaPlugin: Plugin = async () => ({
	tool: {
		hula_send_message: tool({
			description: '回复当前聊天对话。把要发给用户看的内容放进 content。',
			args: { content: tool.schema.string() },
			// declaration-only; aichat-node performs the real send from the SSE record.
			async execute() {
				return '已发送到聊天。';
			},
		}),
		hula_skip_reply: tool({
			description: '本轮不回复聊天（纯客套/无需回应时）。',
			args: { reason: tool.schema.string().optional() },
			async execute() {
				return '本轮已跳过回复。';
			},
		}),
	},
});

export default HulaPlugin;
