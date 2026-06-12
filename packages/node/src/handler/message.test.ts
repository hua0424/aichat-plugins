import { describe, it, expect, vi } from 'vitest';
import { MessageHandler } from './message.js';
import type { HulaWSClient } from '../server/hula-ws.js';
import type { ClawAdapter, ThinkingCallbacks, ChatContext } from '../claw/interface.js';
import { WSReqType } from '../stream/protocol.js';
import type { ReceivedMessage } from '../stream/protocol.js';

const THINKING_END = WSReqType.THINKING_END;
const THINKING_DELTA = WSReqType.THINKING_DELTA;

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

/**
 * 构造一条来自普通用户的文本 receiveMessage。
 * 默认 roomType=2（私聊），始终触发——保持既有 S2/S3/S4 用例语义（不受 S5 @ 闸门影响）。
 */
function humanMessage(roomId: number, fromUid: number, content: string, msgId: number): ReceivedMessage {
	return {
		fromUser: { uid: fromUid, name: 'user', userType: 1 },
		message: { id: msgId, roomId, type: 1, roomType: 2, body: { content } },
	} as unknown as ReceivedMessage;
}

/** 构造一条群聊文本消息（roomType=1），可选 atUidList / name。 */
function groupMessage(
	roomId: number,
	fromUid: number,
	content: string,
	msgId: number,
	opts?: { atUidList?: Array<string | number>; name?: string },
): ReceivedMessage {
	return {
		fromUser: { uid: fromUid, name: opts?.name ?? 'user', userType: 1 },
		message: {
			id: msgId,
			roomId,
			type: 1,
			roomType: 1,
			body: { content, ...(opts?.atUidList ? { atUidList: opts.atUidList } : {}) },
		},
	} as unknown as ReceivedMessage;
}

/** 读取指定房间的积累缓冲（白盒断言用） */
function getAccumulated(handler: MessageHandler, roomId: number): string[] {
	// @ts-expect-error 访问私有字段做白盒断言
	return handler.roomChannels.get(roomId)?.accumulatedMessages ?? [];
}

/** 读取指定房间的 pendingMessages（白盒断言用） */
function getPending(handler: MessageHandler, roomId: number): string[] {
	// @ts-expect-error 访问私有字段做白盒断言
	return handler.roomChannels.get(roomId)?.pendingMessages ?? [];
}

/** 向 handler 注入一条群配置（mentionRequired 等） */
function setGroupConfig(
	handler: MessageHandler,
	roomId: number,
	config: { mentionRequired?: boolean; respondToAi?: boolean; rateLimitPerMinute?: number; dailyLimit?: number },
): void {
	handler.handle({
		type: 'groupConfigChange',
		data: {
			aiclawUid: SELF_UID,
			roomId,
			config: {
				rateLimitPerMinute: config.rateLimitPerMinute ?? 0,
				mentionRequired: config.mentionRequired ?? true,
				dailyLimit: config.dailyLimit ?? 0,
				respondToAi: config.respondToAi ?? false,
			},
		},
	} as never);
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

		cb.onThinkingDelta('reasoning');
		cb.onTerminalTool!({ action: 'sent', tool: 'hula_send_message' });
		cb.onThinkingEnd(100);

		const end = sent.find((f) => f.type === THINKING_END)!.data as Record<string, unknown>;
		expect(end.status).toBe('complete');
		expect(end).not.toHaveProperty('skipReason');
		// S4: END 帧同时携带累计内容
		expect(end.content).toBe('reasoning');
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

	it('ignores a terminal event arriving AFTER finalize (out-of-order, no double-account)', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws, sent } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 });

		handler.handle({ type: 'receiveMessage', data: humanMessage(1, 100, 'hi', 1) } as never);
		await waitFor(() => calls.length >= 1);
		const cb = calls[0].callbacks;

		// 本轮无终结工具 → onThinkingEnd 兜底补记 auto-skip 并结算
		cb.onThinkingEnd(100);
		const endFrame = sent.find((f) => f.type === THINKING_END)!.data as Record<string, unknown>;
		expect(endFrame.skipReason).toBe('agent_no_terminal_tool');

		// finalize 之后到达的迟到 terminal 事件必须被忽略，不得改写已结算账本、不得再发帧
		const endFramesBefore = sent.filter((f) => f.type === THINKING_END).length;
		cb.onTerminalTool!({ action: 'sent', tool: 'hula_send_message' });
		expect(sent.filter((f) => f.type === THINKING_END).length).toBe(endFramesBefore);
		// 已发出的 THINKING_END 仍是兜底 skip，未被迟到 sent 篡改
		expect((sent.find((f) => f.type === THINKING_END)!.data as Record<string, unknown>).skipReason).toBe('agent_no_terminal_tool');
	});

	it('S4: onThinkingDelta accumulates chunks but NEVER sends a THINKING_DELTA frame', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws, sent } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 });

		handler.handle({ type: 'receiveMessage', data: humanMessage(1, 100, 'hi', 1) } as never);
		await waitFor(() => calls.length >= 1);
		const cb = calls[0].callbacks;

		// 即使没有 thinkingId 回填，也不缓存、不发送 delta 帧
		cb.onThinkingDelta('hello ');
		cb.onThinkingDelta('world');

		expect(sent.some((f) => f.type === THINKING_DELTA)).toBe(false);
	});

	it('S4: THINKING_END carries the full accumulated content', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws, sent } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 });

		handler.handle({ type: 'receiveMessage', data: humanMessage(1, 100, 'hi', 1) } as never);
		await waitFor(() => calls.length >= 1);
		const cb = calls[0].callbacks;

		cb.onThinkingDelta('foo');
		cb.onThinkingDelta('bar');
		cb.onThinkingDelta('baz');
		cb.onThinkingEnd(100);

		const end = sent.find((f) => f.type === THINKING_END)!.data as Record<string, unknown>;
		expect(end.status).toBe('complete');
		expect(end.content).toBe('foobarbaz');
	});

	it('S4: error path → END has status error AND content === accumulated (partial)', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws, sent } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 });

		handler.handle({ type: 'receiveMessage', data: humanMessage(1, 100, 'hi', 1) } as never);
		await waitFor(() => calls.length >= 1);
		const cb = calls[0].callbacks;

		cb.onThinkingDelta('partial-');
		cb.onThinkingDelta('text');
		cb.onError(new Error('boom'));

		const end = sent.find((f) => f.type === THINKING_END)!.data as Record<string, unknown>;
		expect(end.status).toBe('error');
		expect(end.error).toBe('boom');
		expect(end.content).toBe('partial-text');
	});

	it('S4: timeout path → END has status error, error thinking_session_timeout, content === accumulated', async () => {
		vi.useFakeTimers();
		try {
			const { adapter, calls } = fakeAdapter();
			const { ws, sent } = fakeWs();
			const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 1, maxWaitMs: 1 });

			handler.handle({ type: 'receiveMessage', data: humanMessage(1, 100, 'hi', 1) } as never);
			// flush debouncer → triggerAgentLoop → adapter.chat called
			await vi.advanceTimersByTimeAsync(5);
			expect(calls.length).toBe(1);
			const cb = calls[0].callbacks;

			cb.onThinkingDelta('before-');
			cb.onThinkingDelta('timeout');

			// 推进到 5 分钟超时
			await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 10);

			const end = sent.find((f) => f.type === THINKING_END)!.data as Record<string, unknown>;
			expect(end.status).toBe('error');
			expect(end.error).toBe('thinking_session_timeout');
			expect(end.content).toBe('before-timeout');
		} finally {
			vi.useRealTimers();
		}
	});

	it('S4: thinkingId still backfills from thinkingStart broadcast → END carries it', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws, sent } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 });

		handler.handle({ type: 'receiveMessage', data: humanMessage(1, 100, 'hi', 1) } as never);
		await waitFor(() => calls.length >= 1);
		const cb = calls[0].callbacks;

		// server 广播 thinkingStart 回填 thinkingId
		handler.handle({
			type: 'thinkingStart',
			data: { fromUid: SELF_UID, roomId: 1, triggerMsgId: '1', thinkingId: 'tid-abc' },
		} as never);

		cb.onThinkingDelta('x');
		cb.onThinkingEnd(100);

		const end = sent.find((f) => f.type === THINKING_END)!.data as Record<string, unknown>;
		expect(end.thinkingId).toBe('tid-abc');
		expect(end.content).toBe('x');
	});

	it('S4: caps THINKING_END content to 256KB UTF-8 without corrupting multibyte chars', async () => {
		const MAX_BYTES = 256 * 1024;
		const { adapter, calls } = fakeAdapter();
		const { ws, sent } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 });

		handler.handle({ type: 'receiveMessage', data: humanMessage(1, 100, 'hi', 1) } as never);
		await waitFor(() => calls.length >= 1);
		const cb = calls[0].callbacks;

		// 用 3 字节的多字节字符（'喵' = E5 96 B5）填充，使总字节数刻意跨越 256KB 边界，
		// 且 256KB 不是 3 的整数倍 → 边界正好落在某个字符中间，验证不切坏多字节字符。
		const multibyte = '喵'; // 3 bytes in UTF-8
		const charCount = Math.ceil((MAX_BYTES + 10) / 3); // 超过上限若干字节
		const huge = multibyte.repeat(charCount);
		expect(new TextEncoder().encode(huge).length).toBeGreaterThan(MAX_BYTES);

		cb.onThinkingDelta(huge);
		cb.onThinkingEnd(100);

		const end = sent.find((f) => f.type === THINKING_END)!.data as Record<string, unknown>;
		const content = end.content as string;
		const bytes = new TextEncoder().encode(content);
		// 1) 不超过帧安全上限
		expect(bytes.length).toBeLessThanOrEqual(MAX_BYTES);
		// 2) 未被截坏：内容是原文的合法前缀，且不含 U+FFFD 替换字符（无半个字符残留）
		expect(content).not.toContain('�');
		expect(huge.startsWith(content)).toBe(true);
		// 3) 确实接近上限（保留了尽可能多的内容，只丢了不足一个字符的尾字节）
		expect(bytes.length).toBeGreaterThan(MAX_BYTES - 3);
	});

	it('S4: content under the 256KB cap passes through unchanged', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws, sent } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 });

		handler.handle({ type: 'receiveMessage', data: humanMessage(1, 100, 'hi', 1) } as never);
		await waitFor(() => calls.length >= 1);
		const cb = calls[0].callbacks;

		const small = '喵abc'.repeat(1000); // well under 256KB
		cb.onThinkingDelta(small);
		cb.onThinkingEnd(100);

		const end = sent.find((f) => f.type === THINKING_END)!.data as Record<string, unknown>;
		expect(end.content).toBe(small);
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

describe('MessageHandler S5: 群聊 @ 触发 + 惰性积累', () => {
	it('group + mention_required + @bot → triggers the agent loop', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 });
		setGroupConfig(handler, 1, { mentionRequired: true });

		handler.handle({
			type: 'receiveMessage',
			data: groupMessage(1, 100, 'hey bot', 1, { atUidList: [SELF_UID] }),
		} as never);

		await waitFor(() => calls.length >= 1);
		expect(calls[0].context?.roomId).toBe(1);
		expect(calls[0].message).toBe('hey bot');
		expect(getAccumulated(handler, 1).length).toBe(0);
	});

	it('group + mention_required + NO @bot → NOT triggered, message accumulated', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 });
		setGroupConfig(handler, 1, { mentionRequired: true });

		handler.handle({
			type: 'receiveMessage',
			data: groupMessage(1, 100, 'just chatting', 1, { name: 'alice' }),
		} as never);

		await new Promise((r) => setTimeout(r, 40));
		expect(calls.length).toBe(0);
		expect(getAccumulated(handler, 1)).toEqual(['[alice(100)]: just chatting']);
		expect(getPending(handler, 1).length).toBe(0);
	});

	it('group + mention_required + atUidList=[0] (@所有人) → NOT triggered BUT accumulated', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 });
		setGroupConfig(handler, 1, { mentionRequired: true });

		handler.handle({
			type: 'receiveMessage',
			data: groupMessage(1, 100, '@all 通知', 1, { atUidList: [0], name: 'bob' }),
		} as never);

		await new Promise((r) => setTimeout(r, 40));
		expect(calls.length).toBe(0);
		expect(getAccumulated(handler, 1)).toEqual(['[bob(100)]: @all 通知']);
	});

	it('cap: 51 un-@ messages → buffer holds 50, oldest dropped', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 });
		setGroupConfig(handler, 1, { mentionRequired: true });

		for (let i = 0; i < 51; i++) {
			handler.handle({
				type: 'receiveMessage',
				data: groupMessage(1, 100, `m${i}`, i + 1, { name: 'u' }),
			} as never);
		}

		await new Promise((r) => setTimeout(r, 40));
		const buf = getAccumulated(handler, 1);
		expect(calls.length).toBe(0);
		expect(buf.length).toBe(50);
		// 最旧（m0）被丢弃，最新（m50）保留
		expect(buf[0]).toBe('[u(100)]: m1');
		expect(buf[49]).toBe('[u(100)]: m50');
	});

	it('private (roomType=2) → always triggers, no @ needed; not accumulated', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 });

		handler.handle({
			type: 'receiveMessage',
			data: { fromUser: { uid: 100, name: 'u', userType: 1 }, message: { id: 1, roomId: 3, type: 1, roomType: 2, body: { content: 'dm hi' } } },
		} as never);

		await waitFor(() => calls.length >= 1);
		expect(calls[0].message).toBe('dm hi');
		expect(getAccumulated(handler, 3).length).toBe(0);
	});

	it('group + mention_required=0 (cached config) → every message triggers', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 });
		setGroupConfig(handler, 1, { mentionRequired: false });

		handler.handle({
			type: 'receiveMessage',
			data: groupMessage(1, 100, 'no mention needed', 1),
		} as never);

		await waitFor(() => calls.length >= 1);
		expect(calls[0].message).toBe('no mention needed');
		expect(getAccumulated(handler, 1).length).toBe(0);
	});

	it('annotation format is exactly [name(uid)]: content', async () => {
		const { adapter } = fakeAdapter();
		const { ws } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 });
		setGroupConfig(handler, 1, { mentionRequired: true });

		handler.handle({
			type: 'receiveMessage',
			data: groupMessage(1, 42, 'hello world', 1, { name: 'Carol' }),
		} as never);

		await new Promise((r) => setTimeout(r, 40));
		expect(getAccumulated(handler, 1)).toEqual(['[Carol(42)]: hello world']);
	});

	it('injection: accumulate N un-@ messages, then @bot → adapter message includes accumulated history (prepended) and buffer cleared', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 });
		setGroupConfig(handler, 1, { mentionRequired: true });

		// 2 条未点名 → 积累
		handler.handle({ type: 'receiveMessage', data: groupMessage(1, 100, 'first', 1, { name: 'alice' }) } as never);
		handler.handle({ type: 'receiveMessage', data: groupMessage(1, 101, 'second', 2, { name: 'bob' }) } as never);
		await new Promise((r) => setTimeout(r, 40));
		expect(calls.length).toBe(0);
		expect(getAccumulated(handler, 1).length).toBe(2);

		// 第 3 条点名机器人 → 触发，注入历史
		handler.handle({ type: 'receiveMessage', data: groupMessage(1, 102, 'hey bot', 3, { atUidList: [SELF_UID], name: 'dave' }) } as never);
		await waitFor(() => calls.length >= 1);

		const sent = calls[0].message;
		expect(sent).toContain('[群聊上下文 · 自上次回复以来未点名你的消息]');
		expect(sent).toContain('[alice(100)]: first');
		expect(sent).toContain('[bob(101)]: second');
		expect(sent).toContain('[当前消息]');
		expect(sent).toContain('hey bot');
		// 历史在当前消息之前
		expect(sent.indexOf('[alice(100)]: first')).toBeLessThan(sent.indexOf('hey bot'));
		// 注入后缓冲清空
		expect(getAccumulated(handler, 1).length).toBe(0);
	});

	it('TIMING: with thinking ACTIVE, un-@ group message is accumulated, NOT queued to pendingMessages, and does NOT trigger after thinking ends', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 });
		setGroupConfig(handler, 1, { mentionRequired: true });

		// 点名机器人 → 触发 thinking（adapter.chat 不结束，session 保持 active）
		handler.handle({ type: 'receiveMessage', data: groupMessage(1, 100, 'hey bot', 1, { atUidList: [SELF_UID] }) } as never);
		await waitFor(() => calls.length >= 1);

		// thinking 进行中，来一条未点名群消息 → 必须积累、不入 pendingMessages、不触发
		handler.handle({ type: 'receiveMessage', data: groupMessage(1, 101, 'chatter', 2, { name: 'eve' }) } as never);
		expect(getAccumulated(handler, 1)).toEqual(['[eve(101)]: chatter']);
		expect(getPending(handler, 1).length).toBe(0);

		// 结束 thinking → 不得 flush 未点名消息触发新 chat
		calls[0].callbacks.onThinkingEnd(100);
		await new Promise((r) => setTimeout(r, 40));
		expect(calls.length).toBe(1);
		// 未点名消息仍留在积累缓冲（等下次点名注入）
		expect(getAccumulated(handler, 1)).toEqual(['[eve(101)]: chatter']);
	});

	it('P1-a: triggerAgentLoop early-return (session already active for sessionKey) does NOT clear accumulated buffer (context preserved)', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 });
		setGroupConfig(handler, 1, { mentionRequired: true });

		// 1 条未点名 → 积累，并建立 lastCtx（首条点名提供 msgId）
		handler.handle({ type: 'receiveMessage', data: groupMessage(1, 100, 'context', 1, { name: 'alice' }) } as never);
		// 点名机器人 → 触发 thinking（fake adapter 不结束 → session 保持 active），积累被注入并清空
		handler.handle({ type: 'receiveMessage', data: groupMessage(1, 101, 'hey bot', 2, { atUidList: [SELF_UID] }) } as never);
		await waitFor(() => calls.length >= 1);
		expect(getAccumulated(handler, 1).length).toBe(0);

		// session 仍 active 时，又积累一条未点名群消息
		handler.handle({ type: 'receiveMessage', data: groupMessage(1, 102, 'more context', 3, { name: 'bob' }) } as never);
		expect(getAccumulated(handler, 1)).toEqual(['[bob(102)]: more context']);

		// 直接驱动 triggerAgentLoop（session 已 active）→ 命中并发防护早返回；
		// 缓冲必须保留（P1-a 修复：消费/清空发生在并发防护之后，而非方法顶部）
		// @ts-expect-error 调用私有方法做白盒断言
		await handler.triggerAgentLoop(1, 'direct retrigger');
		expect(calls.length).toBe(1); // 没有发起第二次 chat（早返回）
		expect(getAccumulated(handler, 1)).toEqual(['[bob(102)]: more context']); // 缓冲未被清空
	});

	it('regression: self / autoReply / non-text / AI(respondToAi=false) are neither accumulated nor triggered', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 });
		setGroupConfig(handler, 1, { mentionRequired: true, respondToAi: false });

		// self
		handler.handle({ type: 'receiveMessage', data: { fromUser: { uid: SELF_UID, name: 'me', userType: 1 }, message: { id: 1, roomId: 1, type: 1, roomType: 1, body: { content: 'self' } } } } as never);
		// autoReply
		handler.handle({ type: 'receiveMessage', data: { fromUser: { uid: 100, name: 'u', userType: 1 }, message: { id: 2, roomId: 1, type: 1, roomType: 1, extra: { autoReply: true }, body: { content: 'auto' } } } } as never);
		// non-text
		handler.handle({ type: 'receiveMessage', data: { fromUser: { uid: 100, name: 'u', userType: 1 }, message: { id: 3, roomId: 1, type: 2, roomType: 1, body: { content: 'img' } } } } as never);
		// AI with respondToAi=false
		handler.handle({ type: 'receiveMessage', data: { fromUser: { uid: 200, name: 'ai', userType: 4 }, message: { id: 4, roomId: 1, type: 1, roomType: 1, body: { content: 'ai msg' } } } } as never);

		await new Promise((r) => setTimeout(r, 40));
		expect(calls.length).toBe(0);
		expect(getAccumulated(handler, 1).length).toBe(0);
	});
});
