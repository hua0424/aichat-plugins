import { describe, it, expect } from 'vitest';
import { createSkipReplyTool } from './skip-reply.js';
import type { ToolContext } from '../types.js';

function ctx(sessionKey: string): ToolContext {
	return { sessionKey };
}

describe('createSkipReplyTool (factory)', () => {
	it('returns { ok:true, skipped:true } without a reason', async () => {
		const tool = createSkipReplyTool(ctx('aiclaw-100-room-555'));
		const result = await tool.execute('call-1', {});
		expect(result).toEqual({ ok: true, skipped: true, reason: undefined });
	});

	it('returns { ok:true, skipped:true, reason } when reason given', async () => {
		const tool = createSkipReplyTool(ctx('aiclaw-100-room-555'));
		const result = await tool.execute('call-2', { reason: '纯客套，无需回复' });
		expect(result).toEqual({ ok: true, skipped: true, reason: '纯客套，无需回复' });
	});

	it('never throws on unparseable sessionKey (skip is harmless)', async () => {
		const tool = createSkipReplyTool(ctx('garbage-key'));
		const result = await tool.execute('call-3', { reason: 'whatever' });
		expect(result).toEqual({ ok: true, skipped: true, reason: 'whatever' });
	});

	it('does not declare roomId as a tool parameter', () => {
		const tool = createSkipReplyTool(ctx('aiclaw-100-room-1'));
		const props = (tool.parameters as { properties: Record<string, unknown> }).properties;
		expect(props).not.toHaveProperty('roomId');
		expect(props).toHaveProperty('reason');
	});

	it('has the expected tool name', () => {
		const tool = createSkipReplyTool(ctx('aiclaw-100-room-1'));
		expect(tool.name).toBe('hula_skip_reply');
	});
});
