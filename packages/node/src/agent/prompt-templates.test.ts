import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, type AgentPromptTemplates } from './prompt-templates.js';
import { REPLY_COMMAND } from './reply-contract.js';

// REQ-018 — the shared fixture: raw server-fetched templates (placeholders NOT yet rendered).
// buildSystemPrompt renders them at per-turn session open; the order is identity_anchor →
// persona_section (only when persona is non-blank) → reply_contract.
// 文本与 server 仓 docs/sql/req-018-agent-prompt.sql 的 seed 模板逐字节一致（review #3 修漂移）。
const TEMPLATES: AgentPromptTemplates = {
	identityAnchor:
		'你是本 HuLa 聊天会话的 AI 助理 {displayName}（uid {uid}）。凡系统路由到你这里的消息——包括群聊里对你（@{displayName}）的点名——都是在对你说话，应据内容按下述约定回复；本轮无需回复时自然结束、不发送即可。',
	personaSection: '你的人设：\n{persona}',
	replyContract:
		'你是 HuLa 聊天会话里的 AI 助理。要把回复发送到当前聊天，你必须在 bash 中实际运行命令：{reply_command}。⚠️ 只有运行这条 bash 命令才会真正发送消息；仅仅调用 aichat-reply 技能、或在回答里声称"已发送/我发了"都不会发送任何消息。房间和身份由系统经 AICHAT_BIND 自动绑定——绝不要传 --room/--to/收件人/身份参数。本轮无需回复时不运行即可（本轮自然结束、不发送任何消息）。在你真正运行过该命令之前，绝不要声称已发送。',
};

describe('buildSystemPrompt (REQ-018 — unified system layer)', () => {
	it('renders {displayName}/{uid}/{persona}/{reply_command} placeholders', () => {
		const out = buildSystemPrompt(TEMPLATES, { displayName: 'CCTestAI', uid: '5', persona: '猫娘' });
		expect(out).toContain('CCTestAI');
		expect(out).toContain('（uid 5）');
		expect(out).toContain('猫娘');
		expect(out).toContain('aichat send-message --content "<你的回复>"');
		expect(out).toContain(REPLY_COMMAND);
	});

	it('order is identity_anchor → persona_section → reply_contract', () => {
		const out = buildSystemPrompt(TEMPLATES, { displayName: 'CCTestAI', uid: '5', persona: '猫娘' });
		const anchorIdx = out.indexOf('你是本 HuLa');
		const personaIdx = out.indexOf('猫娘');
		const contractIdx = out.indexOf(REPLY_COMMAND);
		expect(anchorIdx).toBeGreaterThanOrEqual(0);
		expect(personaIdx).toBeGreaterThan(anchorIdx);
		expect(contractIdx).toBeGreaterThan(personaIdx);
	});

	it('persona undefined/null/whitespace → persona section omitted, output = anchor + contract', () => {
		// 新种子 identityAnchor 里 {displayName} 出现两次（裸占位 + @ 引用段 @{displayName}），期望值必须
		// 用 replaceAll 镜像 buildSystemPrompt 的替换语义（replace 只换首个会留下 @{displayName} 残迹）。
		const anchor = TEMPLATES.identityAnchor.replaceAll('{displayName}', 'X').replaceAll('{uid}', '1').trim();
		const contract = TEMPLATES.replyContract.replace('{reply_command}', REPLY_COMMAND).trim();
		for (const persona of [undefined, null, '   \n\t ']) {
			const out = buildSystemPrompt(TEMPLATES, { displayName: 'X', uid: '1', persona });
			expect(out).toBe(`${anchor}\n${contract}`);
			expect(out).not.toContain('你的人设');
		}
	});

	it('displayName missing → uid preserved, no literal `undefined`, no leftover {displayName}', () => {
		const out = buildSystemPrompt(TEMPLATES, { uid: '7', persona: 'p' });
		expect(out).toContain('（uid 7）');
		expect(out).not.toContain('undefined');
		expect(out).not.toContain('{displayName}');
	});

	it('empty displayName → @-mention segment vanishes cleanly (no bare @, no empty parens, uid kept)', () => {
		// review #2：空 displayName 时 `（@{displayName}）` 整段（含 @ 与括号）从输出消失，
		// 输出自然（`对你的点名` 而非 `对你（@）的点名` / `对你（）的点名`）。
		const out = buildSystemPrompt(TEMPLATES, { uid: '7', persona: 'p' });
		expect(out).toContain('对你的点名');
		expect(out).toContain('（uid 7）');
		expect(out).not.toContain('@');
		expect(out).not.toContain('（）');
		expect(out).not.toContain('（@');
		expect(out).not.toContain('{displayName}');
		expect(out).not.toContain('undefined');
	});

	it('non-empty displayName renders the group @-mention as（@名字）and plain anchor with the name', () => {
		const out = buildSystemPrompt(TEMPLATES, { displayName: 'CCTestAI', uid: '5', persona: null });
		expect(out).toContain('AI 助理 CCTestAI（uid 5）');
		expect(out).toContain('对你（@CCTestAI）的点名');
	});

	it('reply contract always carries REPLY_COMMAND (injected at render time)', () => {
		const out = buildSystemPrompt(TEMPLATES, { uid: '1', persona: null });
		expect(out).toContain(REPLY_COMMAND);
	});
});
