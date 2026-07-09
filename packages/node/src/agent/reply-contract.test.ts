import { describe, it, expect } from 'vitest';
import { buildReplyInstruction, REPLY_COMMAND } from './reply-contract.js';

// The single-sourced reply contract shared by openclaw/opencode/codex (aichatoverview#165, formerly
// three byte-identical inline copies). ADR-0004: reply via the `aichat send-message` CLI, not tools.
describe('buildReplyInstruction', () => {
	const out = buildReplyInstruction('原始用户消息');

	it('instructs the `aichat send-message` CLI', () => {
		expect(out).toContain('aichat send-message');
		expect(out).toContain(REPLY_COMMAND);
	});

	it('does NOT reference the retired hula tools', () => {
		expect(out).not.toContain('hula_send_message');
		expect(out).not.toContain('hula_skip_reply');
	});

	it('preserves the user message verbatim at the tail', () => {
		expect(out.endsWith('原始用户消息')).toBe(true);
	});

	it('uses no [SYSTEM] markers (filtered by openclaw security hardening)', () => {
		expect(out).not.toContain('[SYSTEM]');
	});
});
