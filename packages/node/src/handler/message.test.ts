import { describe, it, expect, vi } from 'vitest';
import { MessageHandler } from './message.js';
import type { HulaWSClient } from '../server/hula-ws.js';
import type { ClawAdapter, ThinkingCallbacks, ChatContext } from '../claw/interface.js';
import type { ReceivedMessage } from '../stream/protocol.js';

interface ChatCall {
	message: string;
	sessionKey: string;
	context?: ChatContext;
	callbacks: ThinkingCallbacks;
}

/** fake ClawAdapter：记录每次 chat 调用，不自动结束 thinking */
function fakeAdapter() {
	const calls: ChatCall[] = [];
	const adapter = {
		type: 'fake',
		connect: vi.fn().mockResolvedValue(undefined),
		disconnect: vi.fn().mockResolvedValue(undefined),
		get isConnected() {
			return true;
		},
		chat: vi.fn(async (message: string, sessionKey: string, callbacks: ThinkingCallbacks, context?: ChatContext) => {
			calls.push({ message, sessionKey, context, callbacks });
		}),
	} as unknown as ClawAdapter & { chat: ReturnType<typeof vi.fn> };
	return { adapter, calls };
}

/** fake HulaWSClient：记录发送的帧 */
function fakeWs() {
	const sent: Array<{ type: number; data: unknown }> = [];
	const ws = {
		isConnected: true,
		send: vi.fn((type: number, data: unknown) => {
			sent.push({ type, data });
		}),
	} as unknown as HulaWSClient & { send: ReturnType<typeof vi.fn> };
	return { ws, sent };
}

/** 构造一条来自普通用户的文本 receiveMessage */
function humanMessage(roomId: number, fromUid: number, content: string, msgId: number): ReceivedMessage {
	return {
		fromUser: { uid: fromUid, name: 'user', userType: 1 },
		message: { id: msgId, roomId, type: 1, body: { content } },
	} as unknown as ReceivedMessage;
}

async function waitFor(cond: () => boolean, timeoutMs = 500): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
		await new Promise((r) => setTimeout(r, 5));
	}
}

const SELF_UID = 999;

describe('MessageHandler per-room isolation', () => {
	it('routes two rooms to their own sessionKey + roomId (no cross-room merge)', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws } = fakeWs();
		// 短 debounce，便于测试
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 });

		handler.handle({ type: 'receiveMessage', data: humanMessage(1, 100, 'msg-room-1', 1) } as never);
		handler.handle({ type: 'receiveMessage', data: humanMessage(2, 200, 'msg-room-2', 2) } as never);

		await waitFor(() => calls.length >= 2);

		const byRoom = new Map(calls.map((c) => [c.context?.roomId, c]));
		expect(byRoom.get(1)?.sessionKey).toBe(`aiclaw-${SELF_UID}-room-1`);
		expect(byRoom.get(1)?.message).toBe('msg-room-1');
		expect(byRoom.get(2)?.sessionKey).toBe(`aiclaw-${SELF_UID}-room-2`);
		expect(byRoom.get(2)?.message).toBe('msg-room-2');
		// 没有把两房消息合并
		expect(calls.every((c) => !c.message.includes('\n'))).toBe(true);
	});

	it('does not let room A pending queue leak into room B', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 });

		// room 1 第一条 → 触发 thinking（adapter.chat 不结束，session 保持 active）
		handler.handle({ type: 'receiveMessage', data: humanMessage(1, 100, 'A1', 1) } as never);
		await waitFor(() => calls.length >= 1);
		expect(calls[0].context?.roomId).toBe(1);

		// room 1 thinking 进行中，再来一条 room 1 消息 → 进入 room1 pending（不触发新 chat）
		handler.handle({ type: 'receiveMessage', data: humanMessage(1, 100, 'A2', 2) } as never);

		// room 2 来消息 → 应独立触发自己的 chat，不被 room1 的 active thinking 阻塞
		handler.handle({ type: 'receiveMessage', data: humanMessage(2, 200, 'B1', 3) } as never);
		await waitFor(() => calls.some((c) => c.context?.roomId === 2));

		const room2Call = calls.find((c) => c.context?.roomId === 2)!;
		expect(room2Call.message).toBe('B1');
		// room1 的 pending（A2）不能混进 room2
		expect(room2Call.message).not.toContain('A2');

		// 结束 room1 的 thinking → 只 flush room1 的 pending（A2），不触碰 room2
		const room1Call = calls.find((c) => c.context?.roomId === 1)!;
		room1Call.callbacks.onThinkingEnd(100);
		await waitFor(() => calls.filter((c) => c.context?.roomId === 1).length >= 2);

		const room1Calls = calls.filter((c) => c.context?.roomId === 1);
		expect(room1Calls[1].message).toBe('A2');
		// room2 仍然只有一次调用，没有被 room1 的 flush 误触发
		expect(calls.filter((c) => c.context?.roomId === 2).length).toBe(1);
	});

	it('ignores own messages and non-text messages', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 });

		// 自己发的消息
		handler.handle({
			type: 'receiveMessage',
			data: { fromUser: { uid: SELF_UID, name: 'me', userType: 1 }, message: { id: 1, roomId: 1, type: 1, body: { content: 'self' } } },
		} as never);
		// 非文本消息
		handler.handle({
			type: 'receiveMessage',
			data: { fromUser: { uid: 100, name: 'u', userType: 1 }, message: { id: 2, roomId: 1, type: 2, body: { content: 'img' } } },
		} as never);

		await new Promise((r) => setTimeout(r, 60));
		expect(calls.length).toBe(0);
	});
});
