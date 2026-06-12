import { describe, it, expect, vi } from 'vitest';
import { createSendMessageTool } from './send-message.js';
import type { ToolContext } from '../types.js';
import type { HulaApiClient } from '../hula-api.js';
import type { HulaApiClientPool } from '../hula-api-pool.js';

/** 记录 sendMessage 调用的 fake client */
function fakeClient() {
	return {
		sendMessage: vi.fn().mockResolvedValue({ msgId: 42 }),
	} as unknown as HulaApiClient & { sendMessage: ReturnType<typeof vi.fn> };
}

/** fake pool：按 aiclawUid 返回对应 client */
function fakePool(clients: Record<string, HulaApiClient>) {
	return {
		get: vi.fn((aiclawUid?: string) => {
			if (aiclawUid && clients[aiclawUid]) return clients[aiclawUid];
			throw new Error(`no client for ${aiclawUid}`);
		}),
	} as unknown as HulaApiClientPool;
}

function ctx(sessionKey: string): ToolContext {
	return { sessionKey };
}

describe('createSendMessageTool (factory)', () => {
	it('binds roomId from sessionKey — no roomId param needed', async () => {
		const clientA = fakeClient();
		const pool = fakePool({ '100': clientA });

		const tool = createSendMessageTool(pool, ctx('aiclaw-100-room-555'));
		const result = await tool.execute('call-1', { content: 'hello' });

		expect(clientA.sendMessage).toHaveBeenCalledWith('555', 'hello', undefined);
		expect(result).toEqual({ ok: true, msgId: 42 });
	});

	it('routes two sessions to their own room + own aiclaw client', async () => {
		const clientA = fakeClient();
		const clientB = fakeClient();
		const pool = fakePool({ '100': clientA, '200': clientB });

		// 两个不同 aiclaw、不同房间的 factory 实例（模拟并发会话）
		const toolA = createSendMessageTool(pool, ctx('aiclaw-100-room-1'));
		const toolB = createSendMessageTool(pool, ctx('aiclaw-200-room-2'));

		await toolA.execute('a', { content: 'reply-A' });
		await toolB.execute('b', { content: 'reply-B' });

		// 各归各房、各用各身份，互不串台
		expect(clientA.sendMessage).toHaveBeenCalledWith('1', 'reply-A', undefined);
		expect(clientA.sendMessage).toHaveBeenCalledTimes(1);
		expect(clientB.sendMessage).toHaveBeenCalledWith('2', 'reply-B', undefined);
		expect(clientB.sendMessage).toHaveBeenCalledTimes(1);
	});

	it('passes through extra (thinkingId / autoReply)', async () => {
		const clientA = fakeClient();
		const pool = fakePool({ '100': clientA });
		const tool = createSendMessageTool(pool, ctx('aiclaw-100-room-1'));

		await tool.execute('c', { content: 'hi', extra: { thinkingId: 't1', autoReply: true } });
		expect(clientA.sendMessage).toHaveBeenCalledWith('1', 'hi', { thinkingId: 't1', autoReply: true });
	});

	it('rejects when sessionKey is unparseable (no roomId leakage)', async () => {
		const clientA = fakeClient();
		const pool = fakePool({ '100': clientA });
		const tool = createSendMessageTool(pool, ctx('garbage-key'));

		const result = await tool.execute('d', { content: 'hi' });
		expect(result).toHaveProperty('error');
		expect(clientA.sendMessage).not.toHaveBeenCalled();
	});

	it('rejects empty content', async () => {
		const clientA = fakeClient();
		const pool = fakePool({ '100': clientA });
		const tool = createSendMessageTool(pool, ctx('aiclaw-100-room-1'));

		const result = await tool.execute('e', { content: '   ' });
		expect(result).toHaveProperty('error');
		expect(clientA.sendMessage).not.toHaveBeenCalled();
	});

	it('does not declare roomId as a tool parameter', () => {
		const pool = fakePool({ '100': fakeClient() });
		const tool = createSendMessageTool(pool, ctx('aiclaw-100-room-1'));
		const props = (tool.parameters as { properties: Record<string, unknown> }).properties;
		expect(props).not.toHaveProperty('roomId');
		expect(props).toHaveProperty('content');
	});
});
