import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, type AgentPromptTemplates } from './prompt-templates.js';
import { REPLY_COMMAND } from './reply-contract.js';

// REQ-018 — the shared fixture: raw server-fetched templates (placeholders NOT yet rendered).
// buildSystemPrompt renders them at per-turn session open; the order is identity_anchor →
// persona_section (only when persona is non-blank) → reply_contract.
const TEMPLATES: AgentPromptTemplates = {
	identityAnchor: '你是本 HuLa 聊天会话的 AI 助理{displayName}（uid {uid}）。凡路由到你的消息都是对你说的。',
	personaSection: '你的人设：\n{persona}',
	replyContract: '要回复用户时，请在 bash 中运行命令 `{reply_command}`。无需回复时不运行即可。',
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
		const anchor = TEMPLATES.identityAnchor.replace('{displayName}', 'X').replace('{uid}', '1').trim();
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

	it('reply contract always carries REPLY_COMMAND (injected at render time)', () => {
		const out = buildSystemPrompt(TEMPLATES, { uid: '1', persona: null });
		expect(out).toContain(REPLY_COMMAND);
	});
});
