import { REPLY_COMMAND } from './reply-contract.js';

/**
 * REQ-018 — the server-fetched agent prompt templates. Every driver renders its SYSTEM layer from
 * THESE templates once per per-turn session open (they are NOT baked into the codebase anymore):
 *
 *   - `identityAnchor`  — 身份锚：告诉 agent 它自己是谁（displayName + uid），使群聊 @-点名能被识别为对它说的。
 *   - `personaSection`  — 人设段：owner 配置的 publicPersona，非空白时夹在身份锚与回复契约之间。
 *   - `replyContract`   — 回复契约：要回复必须跑 `{reply_command}`（REPLY_COMMAND 注入），正文输出只是思考。
 *
 * 模板由 HuLa server 下发（GET /api/im/aiclaw/self/prompts，见 api/hula-api.ts getAgentPromptTemplates），
 * 占位符（{displayName}/{uid}/{persona}/{reply_command}）在渲染时才替换。占位符格式不可与 server 侧漂移。
 */
export interface AgentPromptTemplates {
	replyContract: string;
	identityAnchor: string;
	personaSection: string;
}

/** The per-session render context: what the driver knows at openSession time. */
export interface SystemPromptContext {
	/** 本 aiclaw 的显示名（经 handler 的 getSelfName 惰性解析；未解析则身份锚只钉 uid）。 */
	displayName?: string;
	/** 本 aiclaw 的 uid（opaque string，REQ-029）。必填 —— 身份锚永远钉住它。 */
	uid: string;
	/** owner 配置的人设；undefined/null/纯空白 → persona 段整体省略。 */
	persona?: string | null;
}

/**
 * REQ-018 — render the unified system prompt (order fixed): identity_anchor → persona_section (only
 * when persona is non-blank) → reply_contract. Each part is rendered by replacing its placeholders,
 * trimmed, and non-empty parts joined with '\n'.
 */
export function buildSystemPrompt(templates: AgentPromptTemplates, ctx: SystemPromptContext): string {
	const anchor = templates.identityAnchor
		.replaceAll('{displayName}', ctx.displayName ?? '')
		.replaceAll('{uid}', ctx.uid);
	const personaBlock =
		ctx.persona !== undefined && ctx.persona !== null && ctx.persona.trim() !== ''
			? templates.personaSection.replaceAll('{persona}', ctx.persona)
			: '';
	const contract = templates.replyContract.replaceAll('{reply_command}', REPLY_COMMAND);
	return [anchor, personaBlock, contract].map((s) => s.trim()).filter((s) => s.length > 0).join('\n');
}
