import { describe, it, expect, vi } from 'vitest';
import { CapabilityRegistry, sendMessageCapability, type CapabilityContext } from './registry.js';
import type { HulaApiClient } from '../api/hula-api.js';

function fakeCtx(roomId: number) {
	const sendMessage = vi.fn(async () => ({ msgId: 42 }));
	const apiClient = { sendMessage } as unknown as HulaApiClient;
	const ctx: CapabilityContext = { aiclawUid: 7, roomId, apiClient };
	return { ctx, sendMessage };
}

describe('sendMessageCapability', () => {
	it('calls apiClient.sendMessage(roomId, content) with the ctx roomId', async () => {
		const { ctx, sendMessage } = fakeCtx(42);
		const cap = sendMessageCapability();
		const result = await cap(ctx, { content: 'hello' });
		expect(sendMessage).toHaveBeenCalledWith(42, 'hello');
		expect(result).toEqual({ msgId: 42, roomId: 42 });
	});

	it('room comes from ctx, NEVER from args (args.room ignored)', async () => {
		const { ctx, sendMessage } = fakeCtx(42);
		const cap = sendMessageCapability();
		await cap(ctx, { content: 'hi', room: 999 });
		// the spoofed args.room=999 is ignored — the ctx roomId 42 is used
		expect(sendMessage).toHaveBeenCalledWith(42, 'hi');
	});

	it('trims content', async () => {
		const { ctx, sendMessage } = fakeCtx(42);
		await sendMessageCapability()(ctx, { content: '  padded  ' });
		expect(sendMessage).toHaveBeenCalledWith(42, 'padded');
	});

	it('empty / whitespace / non-string content throws', async () => {
		const { ctx } = fakeCtx(42);
		const cap = sendMessageCapability();
		await expect(cap(ctx, { content: '' })).rejects.toThrow();
		await expect(cap(ctx, { content: '   ' })).rejects.toThrow();
		await expect(cap(ctx, {})).rejects.toThrow();
		await expect(cap(ctx, { content: 123 })).rejects.toThrow();
	});
});

describe('CapabilityRegistry', () => {
	it('register + has + invoke a registered capability', async () => {
		const reg = new CapabilityRegistry();
		const cap = vi.fn(async () => ({ ok: 1 }));
		reg.register('thing', cap);
		expect(reg.has('thing')).toBe(true);
		const { ctx } = fakeCtx(1);
		const out = await reg.invoke('thing', ctx, { a: 1 });
		expect(cap).toHaveBeenCalledWith(ctx, { a: 1 });
		expect(out).toEqual({ ok: 1 });
	});

	it('has() is false for an unregistered name', () => {
		expect(new CapabilityRegistry().has('nope')).toBe(false);
	});

	it('invoke() of an unknown command throws', async () => {
		const reg = new CapabilityRegistry();
		const { ctx } = fakeCtx(1);
		await expect(reg.invoke('nope', ctx, {})).rejects.toThrow();
	});
});
