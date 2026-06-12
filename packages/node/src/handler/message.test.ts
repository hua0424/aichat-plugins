import { describe, it, expect, vi } from 'vitest';
import { MessageHandler } from './message.js';
import type { HulaWSClient } from '../server/hula-ws.js';
import type { ClawAdapter, ThinkingCallbacks, ChatContext } from '../claw/interface.js';
import { WSReqType } from '../stream/protocol.js';
import type { ReceivedMessage } from '../stream/protocol.js';

const THINKING_END = WSReqType.THINKING_END;

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

	it('destroy() does not resurrect agent loops from buffered messages', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws } = fakeWs();
		// 长 debounce，确保消息停在 buffer 里还没 flush
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10000, maxWaitMs: 10000 });

		handler.handle({ type: 'receiveMessage', data: humanMessage(1, 100, 'buffered', 1) } as never);
		// 此刻消息在 debouncer buffer 中，尚未触发 chat
		expect(calls.length).toBe(0);

		handler.destroy();
		await new Promise((r) => setTimeout(r, 50));

		// teardown 用 cancel 丢弃缓冲，不得 flush 复活 agent loop
		expect(calls.length).toBe(0);
	});

	it('terminal=sent → THINKING_END carries NO skipReason', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws, sent } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 });

		handler.handle({ type: 'receiveMessage', data: humanMessage(1, 100, 'hi', 1) } as never);
		await waitFor(() => calls.length >= 1);
		const cb = calls[0].callbacks;

		cb.onTerminalTool!({ action: 'sent', tool: 'hula_send_message' });
		cb.onThinkingEnd(100);

		const end = sent.find((f) => f.type === THINKING_END)!.data as Record<string, unknown>;
		expect(end.status).toBe('complete');
		expect(end).not.toHaveProperty('skipReason');
	});

	it('terminal=skipped with reason → THINKING_END carries that skipReason', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws, sent } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 });

		handler.handle({ type: 'receiveMessage', data: humanMessage(1, 100, 'hi', 1) } as never);
		await waitFor(() => calls.length >= 1);
		const cb = calls[0].callbacks;

		cb.onTerminalTool!({ action: 'skipped', tool: 'hula_skip_reply', reason: '纯客套' });
		cb.onThinkingEnd(100);

		const end = sent.find((f) => f.type === THINKING_END)!.data as Record<string, unknown>;
		expect(end.status).toBe('complete');
		expect(end.skipReason).toBe('纯客套');
	});

	it('no terminal tool → onThinkingEnd auto-skips with agent_no_terminal_tool', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws, sent } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 });

		handler.handle({ type: 'receiveMessage', data: humanMessage(1, 100, 'hi', 1) } as never);
		await waitFor(() => calls.length >= 1);
		// 不触发任何 onTerminalTool
		calls[0].callbacks.onThinkingEnd(100);

		const end = sent.find((f) => f.type === THINKING_END)!.data as Record<string, unknown>;
		expect(end.status).toBe('complete');
		expect(end.skipReason).toBe('agent_no_terminal_tool');
	});

	it('send-wins: skipped THEN sent → effective sent, no skipReason', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws, sent } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 });

		handler.handle({ type: 'receiveMessage', data: humanMessage(1, 100, 'hi', 1) } as never);
		await waitFor(() => calls.length >= 1);
		const cb = calls[0].callbacks;

		cb.onTerminalTool!({ action: 'skipped', tool: 'hula_skip_reply', reason: '早退' });
		cb.onTerminalTool!({ action: 'sent', tool: 'hula_send_message' });
		cb.onThinkingEnd(100);

		const end = sent.find((f) => f.type === THINKING_END)!.data as Record<string, unknown>;
		expect(end.status).toBe('complete');
		expect(end).not.toHaveProperty('skipReason');
	});

	it('send-wins: sent THEN skipped → skip ignored, effective sent, no skipReason', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws, sent } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 });

		handler.handle({ type: 'receiveMessage', data: humanMessage(1, 100, 'hi', 1) } as never);
		await waitFor(() => calls.length >= 1);
		const cb = calls[0].callbacks;

		cb.onTerminalTool!({ action: 'sent', tool: 'hula_send_message' });
		cb.onTerminalTool!({ action: 'skipped', tool: 'hula_skip_reply', reason: '太晚了' });
		cb.onThinkingEnd(100);

		const end = sent.find((f) => f.type === THINKING_END)!.data as Record<string, unknown>;
		expect(end.status).toBe('complete');
		expect(end).not.toHaveProperty('skipReason');
	});

	it('evicts idle room channel after thinking ends with empty pending', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 });

		handler.handle({ type: 'receiveMessage', data: humanMessage(7, 100, 'hi', 1) } as never);
		await waitFor(() => calls.length >= 1);

		// 结束 thinking，pending 为空 → 通道应被回收
		calls[0].callbacks.onThinkingEnd(100);
		await new Promise((r) => setTimeout(r, 20));

		// @ts-expect-error 访问私有字段做白盒断言
		expect(handler.roomChannels.has(7)).toBe(false);
	});
});
