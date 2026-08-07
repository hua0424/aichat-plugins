import { describe, it, expect } from 'vitest';
import { REPLY_COMMAND } from './reply-contract.js';

// REQ-018 — the per-turn role-instruction (buildReplyInstruction) is RETIRED: the reply contract now
// lives in server-fetched templates (agent/prompt-templates.ts) rendered into each driver's SYSTEM layer
// (opencode `system`, codex/openclaw AGENTS.md, cc --append-system-prompt). The ONLY thing left here is
// the single-sourced command literal, injected at render time via `{reply_command}` so it can never
// drift between drivers.
describe('REPLY_COMMAND (REQ-018 — single source, injected at render time)', () => {
	it('is the exact reply CLI the agent must run', () => {
		expect(REPLY_COMMAND).toBe('aichat send-message --content "<你的回复>"');
	});

	it('uses no [SYSTEM] markers (filtered by openclaw security hardening)', () => {
		expect(REPLY_COMMAND).not.toContain('[SYSTEM]');
	});

	it('does NOT reference the retired hula tools', () => {
		expect(REPLY_COMMAND).not.toContain('hula_send_message');
		expect(REPLY_COMMAND).not.toContain('hula_skip_reply');
	});
});
