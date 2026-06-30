import { describe, it, expect, vi } from 'vitest';
import { MessageHandler } from './message.js';
import type { HulaWSClient } from '../server/hula-ws.js';
import type { AgentDriver, AgentSession, AgentEvent } from '../agent/events.js';
import { WSReqType } from '../stream/protocol.js';
import type { ReceivedMessage } from '../stream/protocol.js';
import realAiclawGroupPush from './__fixtures__/real-aiclaw-group-push.json' assert { type: 'json' };

const THINKING_END = WSReqType.THINKING_END;
const THINKING_DELTA = WSReqType.THINKING_DELTA;

/**
 * REQ-008 #75: callbacks shim — mirrors the old ThinkingCallbacks surface so the
 * existing tests keep their `cb.onThinkingDelta(...)` style, but now PUSHES
 * AgentEvents into the driver's per-send async stream that the handler consumes.
 *
 * Because the handler maps events via `for await` (async), after pushing a
 * terminal/done/error a test must `await flush()` before asserting the resulting
 * WS sends. `flush()` resolves once the handler has fully drained the stream.
 */
interface CallbacksShim {
	onThinkingDelta(text: string): void;
	onThinkingEnd(durationMs: number): void;
	onError(err: Error): void;
}

interface ChatCall {
	message: string;
	sessionKey: string;
	context?: { roomId: number };
	callbacks: CallbacksShim;
	/** resolves once the handler's for-await loop over this send has fully drained */
	flush: () => Promise<void>;
}

/**
 * fake AgentDriver：每次 openSession().send() 建立一条受控 async 流，
 * 记录一个 ChatCall（含与旧 ThinkingCallbacks 同名的 shim + flush）。
 * fake 不自动结束 thinking——由测试通过 shim 推事件驱动。
 */
function fakeAdapter() {
	const calls: ChatCall[] = [];
	const driver = {
		type: 'fake',
		connect: vi.fn().mockResolvedValue(undefined),
		disconnect: vi.fn().mockResolvedValue(undefined),
		openSession: vi.fn(async (o: { aiclawUid: number; roomId: number; chatContext: Record<string, unknown> }) => {
			const sessionKey = `aiclaw-${o.aiclawUid}-room-${o.roomId}`;
			const session: AgentSession = {
				send(message: string): AsyncIterable<AgentEvent> {
					const buffer: AgentEvent[] = [];
					let done = false;
					let resolveNext: (() => void) | null = null;

					const wake = () => {
						if (resolveNext) {
							const r = resolveNext;
							resolveNext = null;
							r();
						}
					};
					const push = (ev: AgentEvent) => {
						if (done) return;
						buffer.push(ev);
						wake();
					};
					const finish = () => {
						if (done) return;
						done = true;
						wake();
					};

					const callbacks: CallbacksShim = {
						onThinkingDelta: (text) => push({ type: 'thinking', text }),
						onThinkingEnd: (durationMs) => {
							push({ type: 'done', durationMs });
							finish();
						},
						onError: (err) => {
							push({ type: 'error', message: err.message });
							finish();
						},
					};

					calls.push({
						message,
						sessionKey,
						context: { roomId: o.roomId },
						callbacks,
						// Let the handler's async for-await drain the pushed events.
						// A macrotask is more than enough (mapping happens within a few
						// microtasks of each push). Works under real timers; under fake
						// timers tests advance their own timers as before.
						flush: () => new Promise<void>((resolve) => setImmediate(resolve)),
					});

					return {
						async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
							while (true) {
								while (buffer.length > 0) {
									yield buffer.shift()!;
								}
								if (done) return;
								await new Promise<void>((resolve) => {
									resolveNext = resolve;
								});
							}
						},
					};
				},
				// REQ-008 #75: spy so tests can assert the handler best-effort closes the session.
				close: vi.fn(async () => {
					/* no-op for the fake; handler best-effort close */
				}),
			};
			return session;
		}),
	} as unknown as AgentDriver & { openSession: ReturnType<typeof vi.fn> };
	return { adapter: driver, calls };
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

/**
 * 构造一条来自「另一个 AI」（userType=4=AICLAW）的私聊文本消息。
 * 默认 roomType=2（私聊），始终 trigger-eligible；fromUid 默认与 selfUid 不同（对端 aiclaw）。
 */
function aiMessage(roomId: number, fromUid: number, content: string, msgId: number): ReceivedMessage {
	// 真实形状对齐：server 下发的 fromUser 只有 { uid, userType }，不含 name（见 __fixtures__/real-aiclaw-group-push.json）。
	// AI 检测（message.ts:250 isFromAi）只看 userType，不读 name，故移除手写 name 使既有用例也跑在真实形状上。
	return {
		fromUser: { uid: fromUid, userType: 4 },
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

/** 读取内嵌 AntiLoopGuard（白盒断言用） */
function getGuard(handler: MessageHandler): { getAiRoundCount: (roomId: number) => number } {
	// @ts-expect-error 访问私有字段做白盒断言
	return handler.antiLoopGuard;
}

/** 读取指定房间的 antiLoopDelaying 标志（白盒断言用） */
function isDelaying(handler: MessageHandler, roomId: number): boolean {
	// @ts-expect-error 访问私有字段做白盒断言
	return handler.roomChannels.get(roomId)?.antiLoopDelaying === true;
}

/** 读取指定房间本批的 batchAiFromUid（白盒断言用；0=本批无对端 AI 触发消息） */
function getBatchAiFromUid(handler: MessageHandler, roomId: number): number {
	// @ts-expect-error 访问私有字段做白盒断言
	return handler.roomChannels.get(roomId)?.batchAiFromUid ?? 0;
}

/** 读取内嵌 GroupConfigCache 中某房间的配置（白盒断言用） */
function getCachedConfig(
	handler: MessageHandler,
	roomId: number,
):
	| {
			mentionRequired: boolean;
			respondToAi: boolean;
			rateLimitPerMinute: number;
			dailyLimit: number;
			workspaceDir?: string;
			account?: string;
	  }
	| undefined {
	// @ts-expect-error 访问私有字段做白盒断言
	return handler.groupConfigCache.get(SELF_UID, roomId);
}

/** 向 handler 注入一条群配置（mentionRequired 等） */
function setGroupConfig(
	handler: MessageHandler,
	roomId: number,
	config: {
		mentionRequired?: boolean;
		respondToAi?: boolean;
		rateLimitPerMinute?: number;
		dailyLimit?: number;
		/** REQ-009 #85: owner workspace override (rides inside config). */
		workspaceDir?: string;
		/** REQ-009 #85: group human-readable groupkey (rides on the outer message). */
		account?: string;
	},
): void {
	handler.handle({
		type: 'groupConfigChange',
		data: {
			aiclawUid: SELF_UID,
			roomId,
			...(config.account !== undefined ? { account: config.account } : {}),
			config: {
				rateLimitPerMinute: config.rateLimitPerMinute ?? 0,
				mentionRequired: config.mentionRequired ?? true,
				dailyLimit: config.dailyLimit ?? 0,
				respondToAi: config.respondToAi ?? false,
				...(config.workspaceDir !== undefined ? { workspaceDir: config.workspaceDir } : {}),
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

/** 读取指定 sessionKey 的 active thinking session（白盒断言用） */
function getThinkingSession(handler: MessageHandler, sessionKey: string): { agentSession?: AgentSession } | undefined {
	// @ts-expect-error 访问私有字段做白盒断言
	return handler.thinkingSessions.get(sessionKey);
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

	// REQ-010 S1: the terminal-event reply path is retired. A normal turn (thinking + done)
	// finalizes THINKING_END as {status:'complete', content, durationMs} — NEVER a skipReason
	// (reduceThinking no longer emits one). The agent's reply, if any, is sent out-of-band via
	// the loopback capability endpoint, not from a terminal event in this stream.
	it('normal turn (thinking + done) → THINKING_END complete, content, NO skipReason', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws, sent } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 });

		handler.handle({ type: 'receiveMessage', data: humanMessage(1, 100, 'hi', 1) } as never);
		await waitFor(() => calls.length >= 1);
		const cb = calls[0].callbacks;

		cb.onThinkingDelta('reasoning');
		cb.onThinkingEnd(100);
		await calls[0].flush();

		const end = sent.find((f) => f.type === THINKING_END)!.data as Record<string, unknown>;
		expect(end.status).toBe('complete');
		expect(end).not.toHaveProperty('skipReason');
		// S4: END 帧同时携带累计内容
		expect(end.content).toBe('reasoning');
	});

	it('empty thinking turn → THINKING_END complete, empty content, NO skipReason', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws, sent } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 });

		handler.handle({ type: 'receiveMessage', data: humanMessage(1, 100, 'hi', 1) } as never);
		await waitFor(() => calls.length >= 1);
		calls[0].callbacks.onThinkingEnd(100);
		await calls[0].flush();

		const end = sent.find((f) => f.type === THINKING_END)!.data as Record<string, unknown>;
		expect(end.status).toBe('complete');
		expect(end).not.toHaveProperty('skipReason');
		expect(end.content).toBe('');
	});

	// The handler no longer sends a reply from the agent event stream — that path is retired.
	// Even with an apiClient bound, a completed turn must NOT call apiClient.sendMessage (the
	// reply, if any, comes through the loopback capability endpoint instead).
	it('completed turn does NOT call apiClient.sendMessage (reply path retired)', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws } = fakeWs();
		const sendMessage = vi.fn(async () => ({ msgId: 1 }));
		const apiClient = { sendMessage } as unknown as import('../api/hula-api.js').HulaApiClient;
		const handler = new MessageHandler(ws, adapter, SELF_UID, apiClient, { waitMs: 10, maxWaitMs: 50 });

		handler.handle({ type: 'receiveMessage', data: humanMessage(7, 100, 'hi', 1) } as never);
		await waitFor(() => calls.length >= 1);
		const cb = calls[0].callbacks;

		cb.onThinkingDelta('analysis');
		cb.onThinkingEnd(100);
		await calls[0].flush();

		expect(sendMessage).not.toHaveBeenCalled();
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
		await calls[0].flush();

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
		await calls[0].flush();

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
		await calls[0].flush();

		const end = sent.find((f) => f.type === THINKING_END)!.data as Record<string, unknown>;
		expect(end.thinkingId).toBe('tid-abc');
		expect(end.content).toBe('x');
	});

	it('REQ-008 #75: thinkingEnd broadcast finalize closes the agentSession (best-effort) and removes the session', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 });

		// 私聊触发 → 建立 active thinking session（fake adapter 不结束 → session 保持 active）
		handler.handle({ type: 'receiveMessage', data: humanMessage(5, 100, 'hi', 1) } as never);
		await waitFor(() => calls.length >= 1);

		const sessionKey = `aiclaw-${SELF_UID}-room-5`;
		const thinking = getThinkingSession(handler, sessionKey);
		expect(thinking).toBeDefined();
		const closeSpy = thinking!.agentSession!.close as ReturnType<typeof vi.fn>;
		expect(closeSpy).not.toHaveBeenCalled();

		// server 限流拒绝（无 thinkingId 兜底分支）：status=error + rate_limit_exceeded + fromUid=selfUid
		handler.handle({
			type: 'thinkingEnd',
			data: { fromUid: SELF_UID, roomId: 5, status: 'error', error: 'rate_limit_exceeded' },
		} as never);

		// finalize 分支 best-effort close 了 driver session，并移除了 session
		expect(closeSpy).toHaveBeenCalled();
		// @ts-expect-error 访问私有字段做白盒断言
		expect(handler.thinkingSessions.has(sessionKey)).toBe(false);
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
		await calls[0].flush();

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
		await calls[0].flush();

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

	it('REQ-009 #85: group openSession chatContext carries workspaceDir + account from cache', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws } = fakeWs();
		const openSession = (adapter as unknown as { openSession: ReturnType<typeof vi.fn> }).openSession;
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 });
		setGroupConfig(handler, 1, { mentionRequired: true, workspaceDir: '/srv/proj', account: '888888' });

		handler.handle({
			type: 'receiveMessage',
			data: groupMessage(1, 100, 'hey bot', 1, { atUidList: [SELF_UID] }),
		} as never);

		await waitFor(() => calls.length >= 1);
		const ctx = openSession.mock.calls[0][0].chatContext as { workspaceDir?: string; account?: string };
		expect(ctx.workspaceDir).toBe('/srv/proj');
		expect(ctx.account).toBe('888888');
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

	// NOTE: 积累标注 `[name(uid)]:` 真读 fromUser.name，但真实 server 不下发 name（见
	// __fixtures__/real-aiclaw-group-push.json）→ 线上标注会退化成 `[unknown(uid)]:`。这是与防循环
	// 无关的独立**外观**缺口，超出本 issue 范围；此处仍用写死 name 的 groupMessage，留作后续 issue 跟进。
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

	it('regression-anti-loop: M4 direct-path consecutive AI-to-AI rounds still back off after 5 (non-thinking path)', async () => {
		// 回归：不经 thinking 队列、纯 debounce 直达路径，连续 AI-to-AI 轮 > 5 后仍触发指数退避。
		// 用 fake timers 精确控制 debounce flush 与 setTimeout 退避调度。
		vi.useFakeTimers();
		try {
			const { adapter, calls } = fakeAdapter();
			const { ws } = fakeWs();
			const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 1, maxWaitMs: 1 });
			setGroupConfig(handler, 1, { mentionRequired: false, respondToAi: true });

			const guard = getGuard(handler);

			// 逐轮：投递对端 AI 消息 → flush debounce → triggerAgentLoop（评估 guard）→ 结束 thinking。
			// 每轮立刻结束 thinking（同步驱动 onThinkingEnd），保证下一条不会被排队，走直达路径。
			let msgId = 1;
			let delayedAt = -1;
			for (let round = 1; round <= 7; round++) {
				const before = calls.length;
				handler.handle({ type: 'receiveMessage', data: aiMessage(1, 200, `ai-${round}`, msgId++) } as never);
				await vi.advanceTimersByTimeAsync(5);
				if (calls.length > before) {
					// triggerAgentLoop 已进入（未被退避拦截）→ 结束本轮 thinking
					calls[calls.length - 1].callbacks.onThinkingEnd(10);
					await vi.advanceTimersByTimeAsync(5);
				} else if (delayedAt < 0) {
					delayedAt = round;
				}
			}

			// 阈值后退避必然发生：某一轮 triggerAgentLoop 未直接进入（被 delay 拦截）。
			expect(guard.getAiRoundCount(1)).toBeGreaterThan(5);
			expect(delayedAt).toBeGreaterThan(0);
		} finally {
			vi.useRealTimers();
		}
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

/**
 * REQ-004 S8-7: 防循环守卫必须覆盖「思考期间排队」的消息（issue #22）。
 * 旧实现把 guard.check 放在 handleReceiveMessage 的「思考活跃入队」之后早返回前，
 * 导致排队消息经 flushPendingMessages 直推 debouncer → triggerAgentLoop 时绕过守卫，
 * aiRoundCount 永远停在 ~0，指数退避永不触发。修复：把守卫移到 triggerAgentLoop 唯一汇聚点，
 * 按本轮触发 BATCH 评估。
 */
describe('MessageHandler S8-7: anti-loop guard at triggerAgentLoop chokepoint (issue #22)', () => {
	/**
	 * 模拟「慢 agent」一轮：对端 AI 消息在 thinking 活跃期间到达（被排队），随后 thinking 结束
	 * → flush → debounce → triggerAgentLoop。返回本轮是否真正进入了一次新的 chat（未被退避拦截）。
	 */
	async function driveQueuedAiRound(
		handler: MessageHandler,
		calls: ChatCall[],
		roomId: number,
		fromUid: number,
		content: string,
		msgId: number,
	): Promise<boolean> {
		const before = calls.length;
		// 此刻应有一个 active thinking session（上一轮 chat 未结束）→ 新 AI 消息排队
		handler.handle({ type: 'receiveMessage', data: aiMessage(roomId, fromUid, content, msgId) } as never);
		// 结束上一轮 thinking → flush 排队消息 → debounce → triggerAgentLoop
		const last = calls[calls.length - 1];
		last.callbacks.onThinkingEnd(10);
		await vi.advanceTimersByTimeAsync(10);
		return calls.length > before;
	}

	it('REPRODUCE: queued AI-to-AI rounds increment aiRoundCount and trigger backoff after threshold', async () => {
		// 修复前：排队消息绕过守卫 → aiRoundCount 停在 0、永不退避（本断言会失败）。
		// 修复后：守卫在 triggerAgentLoop 评估每个 BATCH → 计数随每轮递增，> 5 轮后调度退避。
		vi.useFakeTimers();
		try {
			const { adapter, calls } = fakeAdapter();
			const { ws } = fakeWs();
			const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 1, maxWaitMs: 1 });
			setGroupConfig(handler, 1, { mentionRequired: false, respondToAi: true });
			const guard = getGuard(handler);

			// 第 1 条对端 AI 消息：无 active session → 直接 debounce → triggerAgentLoop（thinking 活跃，fake 不结束）
			handler.handle({ type: 'receiveMessage', data: aiMessage(1, 200, 'ai-1', 1) } as never);
			await vi.advanceTimersByTimeAsync(5);
			expect(calls.length).toBe(1);

			// 后续每轮：上一轮 thinking 活跃 → 新 AI 消息排队 → 结束上轮 thinking → flush 触发下一轮
			let delayed = false;
			for (let round = 2; round <= 8 && !delayed; round++) {
				const entered = await driveQueuedAiRound(handler, calls, 1, 200, `ai-${round}`, round);
				if (!entered) delayed = true;
			}

			// 修复后：守卫确实看到了排队消息 → 计数累增到阈值以上
			expect(guard.getAiRoundCount(1)).toBeGreaterThan(5);
			// 修复后：阈值后某一轮被退避拦截（触发了 [anti-loop] delay 路径，未直接进入新 chat）
			expect(delayed).toBe(true);
			expect(isDelaying(handler, 1)).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it('REPRODUCE: backoff delayMs follows 5s→15s→30s ladder as queued AI rounds accumulate', async () => {
		vi.useFakeTimers();
		try {
			const { adapter, calls } = fakeAdapter();
			const { ws } = fakeWs();
			const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 1, maxWaitMs: 1 });
			setGroupConfig(handler, 1, { mentionRequired: false, respondToAi: true });

			const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

			handler.handle({ type: 'receiveMessage', data: aiMessage(1, 200, 'ai-1', 1) } as never);
			await vi.advanceTimersByTimeAsync(5);

			// 跑足够多轮让退避进入 5s 档（aiRoundCount 6..10 → 5000ms）。
			// 退避一旦生效，driveQueuedAiRound 不会进入新 chat（rescheduled 触发延后），
			// 此时直接推进退避定时器让 rescheduled trigger 落地继续。
			let sawDelayMs = -1;
			for (let round = 2; round <= 9; round++) {
				const before = calls.length;
				handler.handle({ type: 'receiveMessage', data: aiMessage(1, 200, `ai-${round}`, round) } as never);
				const last = calls[calls.length - 1];
				last.callbacks.onThinkingEnd(10);
				await vi.advanceTimersByTimeAsync(10);
				if (calls.length === before) {
					// 被退避拦截，抓取 delay 日志里的 delayMs
					const delayLog = logSpy.mock.calls.map((c) => String(c[0])).find((s) => s.includes('[anti-loop] delay'));
					expect(delayLog).toBeDefined();
					const m = /delayMs=(\d+)/.exec(delayLog!);
					sawDelayMs = m ? Number(m[1]) : -1;
					break;
				}
			}

			// 退避档位首次落在 5000ms（aiRoundCount 进入 6..10 区间）
			expect(sawDelayMs).toBe(5000);
			logSpy.mockRestore();
		} finally {
			vi.useRealTimers();
		}
	});

	it('human-batch reset / anti-shadowing: human queued THEN AI queued (AI last) → batchSawHuman wins, count resets, no delay', async () => {
		// manager-required：单纯看「最后一条」会被 AI 影子化（AI 在后）。BATCH 语义要求：
		// 只要本批含人类消息，本轮即按人类轮处理 → aiRoundCount 归零、不退避。
		vi.useFakeTimers();
		try {
			const { adapter, calls } = fakeAdapter();
			const { ws } = fakeWs();
			const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 1, maxWaitMs: 1 });
			setGroupConfig(handler, 1, { mentionRequired: false, respondToAi: true });
			const guard = getGuard(handler);

			// 先把 aiRoundCount 顶到阈值以上（纯 AI 排队轮）
			handler.handle({ type: 'receiveMessage', data: aiMessage(1, 200, 'ai-1', 1) } as never);
			await vi.advanceTimersByTimeAsync(5);
			expect(calls.length).toBe(1);
			let delayed = false;
			for (let round = 2; round <= 8 && !delayed; round++) {
				const entered = await driveQueuedAiRound(handler, calls, 1, 200, `ai-${round}`, round);
				if (!entered) delayed = true;
			}
			expect(guard.getAiRoundCount(1)).toBeGreaterThan(5);

			// 退避生效中（antiLoopDelaying=true）。推进退避定时器让 rescheduled trigger 落地，
			// 重新进入一个 active thinking session 以便下面入队。
			await vi.advanceTimersByTimeAsync(35000);
			// 此时应有新的 thinking session（rescheduled skipGuard 触发）
			const beforeMix = calls.length;

			// 在 thinking 活跃期间：先排队一条人类消息，再排队一条 AI 消息（AI 在后 = 影子化场景）
			handler.handle({ type: 'receiveMessage', data: humanMessage(1, 100, 'human says hi', 50) } as never);
			handler.handle({ type: 'receiveMessage', data: aiMessage(1, 200, 'ai after human', 51) } as never);
			expect(getPending(handler, 1).length).toBe(2);

			// 结束 thinking → flush 两条 → debounce 合并为一个 BATCH → triggerAgentLoop
			calls[calls.length - 1].callbacks.onThinkingEnd(10);
			await vi.advanceTimersByTimeAsync(10);

			// 本批含人类消息 → 计数归零、无退避 → 直接进入新 chat
			expect(guard.getAiRoundCount(1)).toBe(0);
			expect(calls.length).toBeGreaterThan(beforeMix);
			expect(isDelaying(handler, 1)).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it('normal single AI-to-AI round (count <= 5) → triggerAgentLoop proceeds immediately, no delay', async () => {
		vi.useFakeTimers();
		try {
			const { adapter, calls } = fakeAdapter();
			const { ws } = fakeWs();
			const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 1, maxWaitMs: 1 });
			setGroupConfig(handler, 1, { mentionRequired: false, respondToAi: true });

			handler.handle({ type: 'receiveMessage', data: aiMessage(1, 200, 'ai-1', 1) } as never);
			await vi.advanceTimersByTimeAsync(5);

			// 立即进入一次 chat，无退避
			expect(calls.length).toBe(1);
			expect(calls[0].message).toBe('ai-1');
			expect(isDelaying(handler, 1)).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it('@-gate negative: in a mention-required group, an un-@\'d peer-AI message is accumulated, never counts as an AI-to-AI round (no batchAiFromUid, aiRoundCount stays 0)', async () => {
		// S8-7 覆盖缺口：既有用例均为私聊/不需点名场景。本用例锁死 @ 闸门的反例——
		// 需点名群里**未点名**的对端 AI 消息只应进积累缓冲，绝不计入防循环计数。
		// 守卫只对「触发的」（@到 / eligible）对端 AI 消息累加 aiRoundCount。
		const { adapter, calls } = fakeAdapter();
		const { ws } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 });
		// 需点名群，且允许响应 AI（排除 respondToAi=false 提前短路，确保是 @ 闸门拦下而非 AI 开关）
		setGroupConfig(handler, 1, { mentionRequired: true, respondToAi: true });
		const guard = getGuard(handler);

		// 群聊（roomType=1）+ 对端 AI（userType=4）+ 未 @ 机器人
		handler.handle({
			type: 'receiveMessage',
			data: {
				fromUser: { uid: 200, name: 'peer-ai', userType: 4 },
				message: { id: 1, roomId: 1, type: 1, roomType: 1, body: { content: 'ai chatter, no @' } },
			},
		} as never);

		await new Promise((r) => setTimeout(r, 40));

		// 未触发：消息只进积累缓冲，不入 pending、不发起 chat
		expect(calls.length).toBe(0);
		expect(getAccumulated(handler, 1)).toEqual(['[peer-ai(200)]: ai chatter, no @']);
		expect(getPending(handler, 1).length).toBe(0);
		// 关键：未点名 AI 消息既不设 batchAiFromUid，也不喂防循环计数
		expect(getBatchAiFromUid(handler, 1)).toBe(0);
		expect(guard.getAiRoundCount(1)).toBe(0);
	});

	it('delay window does NOT drop messages: a message arriving during antiLoopDelaying is queued and reaches a later trigger', async () => {
		vi.useFakeTimers();
		try {
			const { adapter, calls } = fakeAdapter();
			const { ws } = fakeWs();
			const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 1, maxWaitMs: 1 });
			setGroupConfig(handler, 1, { mentionRequired: false, respondToAi: true });
			const guard = getGuard(handler);

			// 顶到退避阈值
			handler.handle({ type: 'receiveMessage', data: aiMessage(1, 200, 'ai-1', 1) } as never);
			await vi.advanceTimersByTimeAsync(5);
			let delayed = false;
			for (let round = 2; round <= 8 && !delayed; round++) {
				const entered = await driveQueuedAiRound(handler, calls, 1, 200, `ai-${round}`, round);
				if (!entered) delayed = true;
			}
			expect(delayed).toBe(true);
			expect(isDelaying(handler, 1)).toBe(true);

			// 退避窗口内到达一条消息 → 必须排队（不丢、不另起触发）
			handler.handle({ type: 'receiveMessage', data: aiMessage(1, 200, 'during-delay', 90) } as never);
			expect(getPending(handler, 1)).toContain('during-delay');

			// 推进退避定时器 → rescheduled trigger 落地，thinking 结束后 flush 排队消息
			await vi.advanceTimersByTimeAsync(35000);
			const idxAfterReschedule = calls.length;
			expect(idxAfterReschedule).toBeGreaterThan(0);
			// 结束 rescheduled 轮的 thinking → flush during-delay
			calls[calls.length - 1].callbacks.onThinkingEnd(10);
			await vi.advanceTimersByTimeAsync(35000);

			// during-delay 消息最终到达某次 triggerAgentLoop（未丢失）
			const reached = calls.some((c) => c.message.includes('during-delay'));
			expect(reached).toBe(true);
			void guard;
		} finally {
			vi.useRealTimers();
		}
	});
});

/**
 * REQ-004 S8-7 anti-false-green: real-shape (server contract) regression.
 *
 * 既有 aiMessage/humanMessage/groupMessage helper 手工写死 `fromUser.name`，而真实 server
 * 下发的 receiveMessage.fromUser 只有 `{ uid, userType }`（无 name）。更早一次 server 修复前
 * 甚至连 userType 都不下发 —— 那时 `isFromAi = fromUser.userType === 4`（message.ts:250）恒为
 * false，整个防循环计数永远停在 0，退避形同虚设；而既有 regression-anti-loop 用例（~line 718）
 * 用写死 userType=4 的 fixture 始终 GREEN，把这个生产环境的死代码盖成绿灯。
 *
 * 本 describe 用「与真实 server 完全同形」的 fixture/builder 重做防循环回归：
 *   - 黄金 fixture 锁死 server 合同（{uid,userType}、无 name、roomType=1）；
 *   - serverGroupAiMessage 从 fixture 的 key 集派生 fromUser 形状，杜绝飘移；
 *   - 退避 / respondToAi 闸门 / 人类重置 全部跑在真实形状上。
 * 这组用例在 server 修复（#23 下发 userType）之前会是 RED（无 userType → isFromAi false →
 * 计数永不爬升 → 永不退避），正是它要守住的 false-green 缺口。
 */
describe('real-shape (server contract) regression', () => {
	// fixture 是从 LIVE server 抓取的逐字帧（见 JSON 内 _provenance）。
	// 要更新请重新抓取真实帧，不要手工编辑（尤其 fromUser.userType）。
	const fixture = realAiclawGroupPush as {
		fromUser: { uid: string; userType: number };
		message: { roomType: number };
	};

	it('contract pin: golden fixture matches the verified live server shape', () => {
		// 对端 AICLAW 发送者：userType=4
		expect(fixture.fromUser.userType).toBe(4);
		// server 不下发 fromUser.name —— 若未来重抓的 fixture 或 server 改动重新引入/丢失字段，此处会捕获
		expect(Object.prototype.hasOwnProperty.call(fixture.fromUser, 'name')).toBe(false);
		// 群聊
		expect(fixture.message.roomType).toBe(1);
	});

	// 从 fixture 派生 fromUser 的 key 集，确保 builder 形状不会偷偷飘移出 server 合同。
	const FIXTURE_FROMUSER_KEYS = Object.keys((realAiclawGroupPush as { fromUser: Record<string, unknown> }).fromUser)
		.filter((k) => k !== '_provenance')
		.sort();

	/**
	 * 真实形状 builder：fromUser 完全镜像 fixture —— `{ uid, userType: 4 }`，**无 name**；
	 * message.roomType=1（群聊）、type=1（文本）。这是反 false-green 的核心：
	 * 测试里的 AI 消息从此与 server 实际下发的形状一致。
	 */
	function serverGroupAiMessage(roomId: number, fromUid: number, content: string, msgId: number): ReceivedMessage {
		const fromUser = { uid: fromUid, userType: 4 };
		// 自校验：builder 的 fromUser key 集必须与真实 fixture 一致（无 name 漏写、无多余字段）
		expect(Object.keys(fromUser).sort()).toEqual(FIXTURE_FROMUSER_KEYS);
		return {
			fromUser,
			message: { id: msgId, roomId, type: 1, roomType: 1, body: { content } },
		} as unknown as ReceivedMessage;
	}

	/** 真实形状 HUMAN 群消息：fromUser `{ uid, userType: 3 }`，无 name，roomType=1。 */
	function serverGroupHumanMessage(roomId: number, fromUid: number, content: string, msgId: number): ReceivedMessage {
		return {
			fromUser: { uid: fromUid, userType: 3 },
			message: { id: msgId, roomId, type: 1, roomType: 1, body: { content } },
		} as unknown as ReceivedMessage;
	}

	it('backoff fires on real-shape AI-to-AI rounds (RED before server #23 sent userType)', async () => {
		// server 修复前：无 userType → isFromAi=false → 计数永不爬升 → 永不退避（本用例会 RED）。
		vi.useFakeTimers();
		try {
			const { adapter, calls } = fakeAdapter();
			const { ws } = fakeWs();
			const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 1, maxWaitMs: 1 });
			setGroupConfig(handler, 1, { mentionRequired: false, respondToAi: true });
			const guard = getGuard(handler);

			// 逐轮投递「真实形状」对端 AI 消息，交替不同 peer uid（≠ selfUid）、不同 msgId、中间无人类消息。
			// 每轮立刻结束 thinking 走直达路径（镜像 line-718 既有用例风格）。
			const peerUids = [200, 201];
			let msgId = 1;
			let delayedAt = -1;
			for (let round = 1; round <= 8; round++) {
				const before = calls.length;
				const fromUid = peerUids[round % peerUids.length];
				handler.handle({ type: 'receiveMessage', data: serverGroupAiMessage(1, fromUid, `ai-${round}`, msgId++) } as never);
				await vi.advanceTimersByTimeAsync(5);
				if (calls.length > before) {
					calls[calls.length - 1].callbacks.onThinkingEnd(10);
					await vi.advanceTimersByTimeAsync(5);
				} else if (delayedAt < 0) {
					delayedAt = round;
				}
			}

			// 计数爬过 5（真实形状被正确识别为 AI），且某一轮被退避拦截
			expect(guard.getAiRoundCount(1)).toBeGreaterThan(5);
			expect(delayedAt).toBeGreaterThan(0);
			expect(isDelaying(handler, 1)).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it('respondToAi=false skips a real-shape AICLAW message (chat NOT called)', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 });
		// 不需点名（排除 @ 闸门），但 respondToAi=false → AI 消息应被第二层开关拦下
		setGroupConfig(handler, 1, { mentionRequired: false, respondToAi: false });

		handler.handle({ type: 'receiveMessage', data: serverGroupAiMessage(1, 200, 'ai chatter', 1) } as never);

		await new Promise((r) => setTimeout(r, 40));
		// userType 缺失时此开关亦失效（isFromAi false → 不进 respondToAi 分支 → 误触发）；
		// 真实形状下 userType=4 被识别 → respondToAi=false 生效 → 不开 session。
		expect((adapter as unknown as { openSession: ReturnType<typeof vi.fn> }).openSession).not.toHaveBeenCalled();
		expect(calls.length).toBe(0);
	});

	it('real-shape HUMAN message resets the AI-to-AI round count', async () => {
		vi.useFakeTimers();
		try {
			const { adapter, calls } = fakeAdapter();
			const { ws } = fakeWs();
			const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 1, maxWaitMs: 1 });
			setGroupConfig(handler, 1, { mentionRequired: false, respondToAi: true });
			const guard = getGuard(handler);

			// 先用真实形状 AI 轮把计数顶起来
			let msgId = 1;
			for (let round = 1; round <= 4; round++) {
				const before = calls.length;
				handler.handle({ type: 'receiveMessage', data: serverGroupAiMessage(1, 200, `ai-${round}`, msgId++) } as never);
				await vi.advanceTimersByTimeAsync(5);
				if (calls.length > before) {
					calls[calls.length - 1].callbacks.onThinkingEnd(10);
					await vi.advanceTimersByTimeAsync(5);
				}
			}
			expect(guard.getAiRoundCount(1)).toBeGreaterThan(0);

			// 真实形状人类消息（userType=3，无 name）→ 本批按人类轮处理 → 计数归零
			handler.handle({ type: 'receiveMessage', data: serverGroupHumanMessage(1, 100, 'human breaks in', msgId++) } as never);
			await vi.advanceTimersByTimeAsync(5);
			const last = calls[calls.length - 1];
			last.callbacks.onThinkingEnd(10);
			await vi.advanceTimersByTimeAsync(5);

			expect(guard.getAiRoundCount(1)).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('MessageHandler.prewarmGroupConfigs (REQ #26)', () => {
	/** fake HulaApiClient：仅实现 listSelfGroupConfigs，记录调用次数 */
	function fakeApiClient(
		impl: () => Promise<
			Array<{
				roomId: number;
				mentionRequired?: number;
				respondToAi?: number;
				rateLimitPerMinute?: number;
				dailyLimit?: number;
				workspaceDir?: string;
				account?: string;
			}>
		>,
	) {
		const listSelfGroupConfigs = vi.fn(impl);
		const apiClient = { listSelfGroupConfigs } as unknown as import('../api/hula-api.js').HulaApiClient & {
			listSelfGroupConfigs: ReturnType<typeof vi.fn>;
		};
		return { apiClient, listSelfGroupConfigs };
	}

	it('prewarmFillsCacheFromListApi: 用 list API 填充两条不同房间的配置', async () => {
		const { adapter } = fakeAdapter();
		const { ws } = fakeWs();
		const { apiClient } = fakeApiClient(async () => [
			{ roomId: 10, mentionRequired: 0, respondToAi: 1, rateLimitPerMinute: 5, dailyLimit: 100 },
			{ roomId: 20, mentionRequired: 1, respondToAi: 0, rateLimitPerMinute: 3, dailyLimit: 50 },
		]);
		const handler = new MessageHandler(ws, adapter, SELF_UID, apiClient);

		await handler.prewarmGroupConfigs();

		const c10 = getCachedConfig(handler, 10);
		expect(c10).toBeDefined();
		expect(c10!.mentionRequired).toBe(false);
		expect(c10!.respondToAi).toBe(true);
		expect(c10!.rateLimitPerMinute).toBe(5);
		expect(c10!.dailyLimit).toBe(100);

		const c20 = getCachedConfig(handler, 20);
		expect(c20).toBeDefined();
		expect(c20!.mentionRequired).toBe(true);
		expect(c20!.respondToAi).toBe(false);
		expect(c20!.rateLimitPerMinute).toBe(3);
		expect(c20!.dailyLimit).toBe(50);
	});

	it('REQ-009 #85: prewarm carries workspaceDir + account through the cache', async () => {
		const { adapter } = fakeAdapter();
		const { ws } = fakeWs();
		const { apiClient } = fakeApiClient(async () => [
			{ roomId: 10, mentionRequired: 1, respondToAi: 0, rateLimitPerMinute: 5, dailyLimit: 100, workspaceDir: '/srv/proj', account: '888888' },
			{ roomId: 20, mentionRequired: 1, respondToAi: 0, rateLimitPerMinute: 5, dailyLimit: 100 },
		]);
		const handler = new MessageHandler(ws, adapter, SELF_UID, apiClient);

		await handler.prewarmGroupConfigs();

		const c10 = getCachedConfig(handler, 10);
		expect(c10!.workspaceDir).toBe('/srv/proj');
		expect(c10!.account).toBe('888888');

		// roomId 20 had neither → both undefined (default derive downstream)
		const c20 = getCachedConfig(handler, 20);
		expect(c20!.workspaceDir).toBeUndefined();
		expect(c20!.account).toBeUndefined();
	});

	it('prewarmIsIdempotent: 连续两次调用 cache 一致且不抛', async () => {
		const { adapter } = fakeAdapter();
		const { ws } = fakeWs();
		const { apiClient, listSelfGroupConfigs } = fakeApiClient(async () => [
			{ roomId: 10, mentionRequired: 1, respondToAi: 0, rateLimitPerMinute: 5, dailyLimit: 100 },
		]);
		const handler = new MessageHandler(ws, adapter, SELF_UID, apiClient);

		await expect(handler.prewarmGroupConfigs()).resolves.toBeUndefined();
		await expect(handler.prewarmGroupConfigs()).resolves.toBeUndefined();

		expect(listSelfGroupConfigs).toHaveBeenCalledTimes(2);
		const c10 = getCachedConfig(handler, 10);
		expect(c10).toBeDefined();
		expect(c10!.mentionRequired).toBe(true);
		expect(c10!.rateLimitPerMinute).toBe(5);
	});

	it('prewarmToleratesApiFailure: list API 抛错时不抛、且不破坏已有 cache', async () => {
		const { adapter } = fakeAdapter();
		const { ws } = fakeWs();
		const { apiClient } = fakeApiClient(async () => {
			throw new Error('network jitter');
		});
		const handler = new MessageHandler(ws, adapter, SELF_UID, apiClient);

		// 预置一条已有 cache（模拟 groupConfigChange 已填充）
		setGroupConfig(handler, 7, { mentionRequired: false, rateLimitPerMinute: 9 });

		await expect(handler.prewarmGroupConfigs()).resolves.toBeUndefined();

		// 原有条目仍在，未被破坏
		const c7 = getCachedConfig(handler, 7);
		expect(c7).toBeDefined();
		expect(c7!.mentionRequired).toBe(false);
		expect(c7!.rateLimitPerMinute).toBe(9);
	});

	it('prewarmNoApiClientIsNoop: apiClient 为 null 时不抛、cache 空', async () => {
		const { adapter } = fakeAdapter();
		const { ws } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined);

		await expect(handler.prewarmGroupConfigs()).resolves.toBeUndefined();

		expect(getCachedConfig(handler, 10)).toBeUndefined();
	});
});

/**
 * REQ-010 S7: external (owner-initiated) thinking path for the CC broker.
 * The CC driver has no room trigger message — the CcBroker drives a thinking session via
 * beginExternalThinking / externalThinkingDelta / endExternalThinking. These mirror the
 * existing ThinkingSession lifecycle (same thinkingSessions map + sessionKey scheme) but with a
 * synthetic triggerMsgId, so handleThinkingStartBroadcast still backfills thinkingId cleanly.
 */
describe('MessageHandler S7: external thinking path (CC broker)', () => {
	const ROOM = 5;
	const sessionKey = `aiclaw-${SELF_UID}-room-${ROOM}`;

	function startFrame(sent: Array<{ type: number; data: unknown }>) {
		return sent.find((f) => f.type === WSReqType.THINKING_START)?.data as Record<string, unknown> | undefined;
	}

	it('beginExternalThinking sends THINKING_START with fromUid/roomId and a synthetic triggerMsgId', () => {
		const { adapter } = fakeAdapter();
		const { ws, sent } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID);

		handler.beginExternalThinking(ROOM, SELF_UID);

		const start = startFrame(sent);
		expect(start).toBeDefined();
		expect(start!.fromUid).toBe(SELF_UID);
		expect(start!.roomId).toBe(ROOM);
		// synthetic id is a non-empty string scoped to the room; NOT Date/random based
		expect(typeof start!.triggerMsgId).toBe('string');
		expect(String(start!.triggerMsgId)).toContain(`cc-ext-${ROOM}-`);
	});

	it('synthetic triggerMsgId is monotonic across rooms (counter, not Date/random)', () => {
		const { adapter } = fakeAdapter();
		const { ws, sent } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID);

		handler.beginExternalThinking(5, SELF_UID);
		handler.endExternalThinking(5, SELF_UID);
		handler.beginExternalThinking(6, SELF_UID);

		const starts = sent.filter((f) => f.type === WSReqType.THINKING_START).map((f) => (f.data as Record<string, unknown>).triggerMsgId as string);
		expect(starts).toHaveLength(2);
		const n0 = Number(starts[0].split('-').pop());
		const n1 = Number(starts[1].split('-').pop());
		expect(n1).toBe(n0 + 1);
	});

	it('double-begin is guarded — a second begin for the same room sends only one THINKING_START', () => {
		const { adapter } = fakeAdapter();
		const { ws, sent } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID);

		handler.beginExternalThinking(ROOM, SELF_UID);
		handler.beginExternalThinking(ROOM, SELF_UID);

		expect(sent.filter((f) => f.type === WSReqType.THINKING_START)).toHaveLength(1);
	});

	it('delta accumulates; end sends THINKING_END complete with full content', () => {
		const { adapter } = fakeAdapter();
		const { ws, sent } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID);

		handler.beginExternalThinking(ROOM, SELF_UID);
		handler.externalThinkingDelta(ROOM, SELF_UID, '[工具] Bash ls\n');
		handler.externalThinkingDelta(ROOM, SELF_UID, 'streaming reply');

		// deltas must NOT emit per-delta frames (matches normal thinking: batched in THINKING_END)
		expect(sent.some((f) => f.type === WSReqType.THINKING_DELTA)).toBe(false);

		handler.endExternalThinking(ROOM, SELF_UID);

		const end = sent.find((f) => f.type === WSReqType.THINKING_END)!.data as Record<string, unknown>;
		expect(end.status).toBe('complete');
		expect(end.content).toBe('[工具] Bash ls\nstreaming reply');
		expect(typeof end.durationMs).toBe('number');
		// session cleared
		// @ts-expect-error 白盒断言
		expect(handler.thinkingSessions.has(sessionKey)).toBe(false);
	});

	it('thinkingId still backfills via thinkingStart broadcast (synthetic triggerMsgId matches)', () => {
		const { adapter } = fakeAdapter();
		const { ws, sent } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID);

		handler.beginExternalThinking(ROOM, SELF_UID);
		const start = startFrame(sent)!;
		const triggerMsgId = String(start.triggerMsgId);

		// server broadcasts thinkingStart carrying the synthetic triggerMsgId → thinkingId backfill
		handler.handle({
			type: 'thinkingStart',
			data: { fromUid: SELF_UID, roomId: ROOM, triggerMsgId, thinkingId: 'tid-ext-1' },
		} as never);

		handler.externalThinkingDelta(ROOM, SELF_UID, 'x');
		handler.endExternalThinking(ROOM, SELF_UID);

		const end = sent.find((f) => f.type === WSReqType.THINKING_END)!.data as Record<string, unknown>;
		expect(end.thinkingId).toBe('tid-ext-1');
		expect(end.content).toBe('x');
	});

	it('delta/end before begin (or after end) are safe no-ops', () => {
		const { adapter } = fakeAdapter();
		const { ws, sent } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID);

		// no session yet
		expect(() => handler.externalThinkingDelta(ROOM, SELF_UID, 'x')).not.toThrow();
		expect(() => handler.endExternalThinking(ROOM, SELF_UID)).not.toThrow();
		expect(sent.length).toBe(0);

		// after a full cycle, a second end is a no-op (single THINKING_END)
		handler.beginExternalThinking(ROOM, SELF_UID);
		handler.endExternalThinking(ROOM, SELF_UID);
		handler.endExternalThinking(ROOM, SELF_UID);
		expect(sent.filter((f) => f.type === WSReqType.THINKING_END)).toHaveLength(1);
	});

	it('does NOT disturb a normal driver-driven thinking session for a DIFFERENT room', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws, sent } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 });

		// normal driver turn in room 1
		handler.handle({ type: 'receiveMessage', data: humanMessage(1, 100, 'hi', 1) } as never);
		await waitFor(() => calls.length >= 1);

		// external CC turn in room 5 — independent
		handler.beginExternalThinking(5, SELF_UID);
		handler.externalThinkingDelta(5, SELF_UID, 'cc thinking');
		handler.endExternalThinking(5, SELF_UID);

		// finish the normal turn
		calls[0].callbacks.onThinkingDelta('normal reasoning');
		calls[0].callbacks.onThinkingEnd(100);
		await calls[0].flush();

		// two distinct THINKING_END frames, each with its own content
		const ends = sent.filter((f) => f.type === WSReqType.THINKING_END).map((f) => f.data as Record<string, unknown>);
		expect(ends.length).toBe(2);
		const contents = ends.map((e) => e.content);
		expect(contents).toContain('cc thinking');
		expect(contents).toContain('normal reasoning');
		// the external turn produced exactly one START with a synthetic id; the normal turn used the real msgId
		const starts = sent.filter((f) => f.type === WSReqType.THINKING_START).map((f) => (f.data as Record<string, unknown>).triggerMsgId as string);
		expect(starts).toContain('1');
		expect(starts.some((s) => s.startsWith('cc-ext-5-'))).toBe(true);
	});
});

describe('MessageHandler S7: drivesTurns=false (owner-driven, e.g. CC)', () => {
	/** A driver wrapper exposing drivesTurns; reuses fakeAdapter so openSession spy stays observable. */
	function ownerDrivenAdapter() {
		const { adapter, calls } = fakeAdapter();
		(adapter as unknown as { drivesTurns: boolean }).drivesTurns = false;
		return { adapter, calls };
	}

	it('does NOT trigger the agent loop on an inbound message (no openSession / no THINKING_START)', async () => {
		const { adapter, calls } = ownerDrivenAdapter();
		const { ws, sent } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 });

		handler.handle({ type: 'receiveMessage', data: humanMessage(1, 100, 'hi cc', 1) } as never);

		// give the debouncer time to fire if it were going to
		await new Promise((r) => setTimeout(r, 80));

		// owner-driven: no openSession call, no THINKING_START frame
		expect(calls.length).toBe(0);
		expect((adapter as unknown as { openSession: ReturnType<typeof vi.fn> }).openSession).not.toHaveBeenCalled();
		expect(sent.filter((f) => f.type === WSReqType.THINKING_START).length).toBe(0);

		// but the inbound message is still ACK'd (dedupe/ACK behavior unchanged)
		expect(sent.filter((f) => f.type === WSReqType.ACK).length).toBe(1);

		// external-thinking (the broker path) still works for a cc identity
		handler.beginExternalThinking(1, SELF_UID);
		handler.externalThinkingDelta(1, SELF_UID, 'cc panel');
		handler.endExternalThinking(1, SELF_UID);
		const ends = sent.filter((f) => f.type === WSReqType.THINKING_END).map((f) => (f.data as Record<string, unknown>).content);
		expect(ends).toContain('cc panel');
	});

	it('regression: a normal driver (drivesTurns undefined) still drives the agent loop', async () => {
		const { adapter, calls } = fakeAdapter(); // drivesTurns undefined → default true semantics
		const { ws, sent } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 });

		handler.handle({ type: 'receiveMessage', data: humanMessage(1, 100, 'hi normal', 1) } as never);
		await waitFor(() => calls.length >= 1);

		expect(calls[0].message).toBe('hi normal');
		expect(sent.filter((f) => f.type === WSReqType.THINKING_START).length).toBe(1);
	});

	// ─── REQ-011 S2: cc DM-inbound delivery via channelPush (post anti-loop guard, DM-only) ───

	it('cc + DM + guard allow → channelPush(roomId, content) once; no openSession / no THINKING_START', async () => {
		const { adapter, calls } = ownerDrivenAdapter();
		const { ws, sent } = fakeWs();
		const channelPush = vi.fn();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, undefined, channelPush);

		// humanMessage defaults to roomType=2 (DM).
		handler.handle({ type: 'receiveMessage', data: humanMessage(1, 100, 'hi cc dm', 1) } as never);
		await waitFor(() => channelPush.mock.calls.length >= 1);

		expect(channelPush).toHaveBeenCalledTimes(1);
		expect(channelPush).toHaveBeenCalledWith(1, 'hi cc dm');
		expect((adapter as unknown as { openSession: ReturnType<typeof vi.fn> }).openSession).not.toHaveBeenCalled();
		expect(sent.filter((f) => f.type === WSReqType.THINKING_START).length).toBe(0);
		expect(calls.length).toBe(0);
	});

	it('cc + DM but anti-loop DELAY → channelPush NOT called (guard returns before the cc branch)', async () => {
		vi.useFakeTimers();
		try {
			const { adapter } = ownerDrivenAdapter();
			const { ws } = fakeWs();
			const channelPush = vi.fn();
			const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 1, maxWaitMs: 1 }, undefined, channelPush);
			// DM with respondToAi → consecutive AI messages accumulate aiRoundCount; cc never holds a
			// thinking session (drivesTurns=false), so each AI msg flushes straight through the guard.
			setGroupConfig(handler, 1, { respondToAi: true });
			const guard = getGuard(handler);

			// Drive enough consecutive opposite-AI DM rounds to push aiRoundCount past 5 → guard delays.
			for (let i = 1; i <= 8; i++) {
				handler.handle({ type: 'receiveMessage', data: aiMessage(1, 200, `ai-${i}`, i) } as never);
				await vi.advanceTimersByTimeAsync(2);
			}

			// the guard actually engaged (real guard, not stubbed)
			expect(guard.getAiRoundCount(1)).toBeGreaterThan(5);
			expect(isDelaying(handler, 1)).toBe(true);
			// the delayed round returned BEFORE the cc branch → that round did not push.
			// (early DM rounds before the threshold DID push; what we prove is the guard gates cc too:
			//  a delayed round produces NO push for that round.)
			const pushesBeforeDelay = channelPush.mock.calls.length;
			// advancing the backoff timer reschedules with skipGuard — still a cc DM → it WILL push then,
			// proving the only suppression was the guard's delay window, not a cc bypass.
			await vi.advanceTimersByTimeAsync(35000);
			expect(channelPush.mock.calls.length).toBeGreaterThan(pushesBeforeDelay);
		} finally {
			vi.useRealTimers();
		}
	});

	it('cc + GROUP (@bot, allow) → channelPush NOT called (S2 is DM-only); no openSession', async () => {
		const { adapter } = ownerDrivenAdapter();
		const { ws, sent } = fakeWs();
		const channelPush = vi.fn();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, undefined, channelPush);

		// trigger-eligible group message: @ the bot.
		handler.handle({ type: 'receiveMessage', data: groupMessage(1, 100, 'hey bot', 1, { atUidList: [SELF_UID] }) } as never);
		await new Promise((r) => setTimeout(r, 80));

		expect(channelPush).not.toHaveBeenCalled();
		expect((adapter as unknown as { openSession: ReturnType<typeof vi.fn> }).openSession).not.toHaveBeenCalled();
		expect(sent.filter((f) => f.type === WSReqType.THINKING_START).length).toBe(0);
	});

	it('regression: a normal driver + DM ignores channelPush (drives the loop, never pushes)', async () => {
		const { adapter, calls } = fakeAdapter(); // drivesTurns undefined → node-driven
		const { ws, sent } = fakeWs();
		const channelPush = vi.fn();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, undefined, channelPush);

		handler.handle({ type: 'receiveMessage', data: humanMessage(1, 100, 'hi normal', 1) } as never);
		await waitFor(() => calls.length >= 1);

		expect(channelPush).not.toHaveBeenCalled();
		expect(sent.filter((f) => f.type === WSReqType.THINKING_START).length).toBe(1);
	});

	it('flush gap: 2nd DM arriving during cc external-thinking is queued, then flushed → channelPush on endExternalThinking', async () => {
		const { adapter } = ownerDrivenAdapter();
		const { ws } = fakeWs();
		const channelPush = vi.fn();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, undefined, channelPush);

		// 1st DM → delivered to the channel (cc DM branch).
		handler.handle({ type: 'receiveMessage', data: humanMessage(1, 100, 'dm-1', 1) } as never);
		await waitFor(() => channelPush.mock.calls.length >= 1);
		expect(channelPush).toHaveBeenCalledWith(1, 'dm-1');

		// CC begins processing it (its hook fires) → an external thinking session is active for the room.
		handler.beginExternalThinking(1, SELF_UID);

		// A 2nd DM arrives WHILE external thinking is active → handleReceiveMessage QUEUES it (not pushed),
		// because an owner-driven cc identity has no node-driven turn to consume it mid-thinking.
		handler.handle({ type: 'receiveMessage', data: humanMessage(1, 100, 'dm-2', 2) } as never);
		await new Promise((r) => setTimeout(r, 40));
		expect(channelPush).toHaveBeenCalledTimes(1); // still only dm-1 — dm-2 is queued
		expect(getPending(handler, 1)).toContain('dm-2');

		// external thinking ends → flushPendingMessages (the S2 fix) → dm-2 re-enters triggerAgentLoop →
		// the cc DM branch → channelPush. Without the flush, dm-2 would be stuck in pendingMessages forever.
		handler.endExternalThinking(1, SELF_UID);
		await waitFor(() => channelPush.mock.calls.length >= 2);
		expect(channelPush).toHaveBeenCalledWith(1, 'dm-2');
	});
});

// ─── REQ-010 S9: ccBindRequest → CC_BIND_RESULT (node side of the server↔node bind RPC) ───

const CC_BIND_RESULT = WSReqType.CC_BIND_RESULT;

/**
 * fake cc AgentDriver: `type:'cc'` + a spied `bind` returning canned CcBindInstructions.
 * Mirrors CcDriver's surface (drivesTurns=false; openSession throws). `bind` is a spy so the
 * tests can assert (uid, roomId, chatContext) it was called with.
 */
function fakeCcDriver() {
	const bind = vi.fn((_uid: number, _roomId: number, _ctx: Record<string, unknown>) => ({
		token: 'aiclaw-999-room-7',
		launchCommand: 'cd /ws && AICHAT_BIND=aiclaw-999-room-7 claude --settings /ws/.claude/settings.json',
		settingsPath: '/ws/.claude/settings.json',
		workspaceDir: '/ws',
	}));
	const driver = {
		type: 'cc',
		drivesTurns: false,
		connect: vi.fn().mockResolvedValue(undefined),
		disconnect: vi.fn().mockResolvedValue(undefined),
		openSession: vi.fn(async () => {
			throw new Error('cc is owner-driven');
		}),
		bind,
	} as unknown as AgentDriver & { bind: ReturnType<typeof vi.fn> };
	return { driver, bind };
}

describe('MessageHandler S9: ccBindRequest → CC_BIND_RESULT', () => {
	it('cc identity, group request → bind called with group context + CC_BIND_RESULT with launchCommand/workspaceDir (no error)', () => {
		const { driver, bind } = fakeCcDriver();
		const { ws, sent } = fakeWs();
		const handler = new MessageHandler(ws, driver, SELF_UID);

		handler.handle({
			type: 'ccBindRequest',
			data: { roomId: 7, roomType: 1, requestId: 'req-g1' },
		} as never);

		// bind called with (selfUid, roomId, group chatContext)
		expect(bind).toHaveBeenCalledTimes(1);
		expect(bind).toHaveBeenCalledWith(SELF_UID, 7, { roomType: 1, roomId: 7 });

		const result = sent.find((f) => f.type === CC_BIND_RESULT);
		expect(result).toBeDefined();
		const data = result!.data as Record<string, unknown>;
		expect(data.requestId).toBe('req-g1');
		expect(data.launchCommand).toBe(
			'cd /ws && AICHAT_BIND=aiclaw-999-room-7 claude --settings /ws/.claude/settings.json',
		);
		expect(data.workspaceDir).toBe('/ws');
		expect('error' in data).toBe(false);
	});

	it('cc identity, dm request → bind called with dm context (counterpartUid)', () => {
		const { driver, bind } = fakeCcDriver();
		const { ws, sent } = fakeWs();
		const handler = new MessageHandler(ws, driver, SELF_UID);

		handler.handle({
			type: 'ccBindRequest',
			data: { roomId: 12, roomType: 2, counterpartUid: 555, requestId: 'req-d1' },
		} as never);

		expect(bind).toHaveBeenCalledWith(SELF_UID, 12, { roomType: 2, roomId: 12, counterpartUid: 555 });
		const data = sent.find((f) => f.type === CC_BIND_RESULT)!.data as Record<string, unknown>;
		expect(data.requestId).toBe('req-d1');
		expect('error' in data).toBe(false);
	});

	it('non-cc identity → CC_BIND_RESULT with error, bind NOT called', () => {
		const { adapter } = fakeAdapter(); // type:'fake', no bind
		const bindProbe = vi.fn();
		// attach a bind spy to ensure it is NEVER reached (defensive guard is type-based)
		(adapter as unknown as { bind: unknown }).bind = bindProbe;
		const { ws, sent } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID);

		handler.handle({
			type: 'ccBindRequest',
			data: { roomId: 7, roomType: 1, requestId: 'req-nc' },
		} as never);

		expect(bindProbe).not.toHaveBeenCalled();
		const data = sent.find((f) => f.type === CC_BIND_RESULT)!.data as Record<string, unknown>;
		expect(data.requestId).toBe('req-nc');
		expect(typeof data.error).toBe('string');
		expect(data.error).toBeTruthy();
		expect('launchCommand' in data).toBe(false);
	});

	it('bind throws → CC_BIND_RESULT with error and handle() does not throw', () => {
		const { driver, bind } = fakeCcDriver();
		bind.mockImplementation(() => {
			throw new Error('boom from bind');
		});
		const { ws, sent } = fakeWs();
		const handler = new MessageHandler(ws, driver, SELF_UID);

		expect(() =>
			handler.handle({
				type: 'ccBindRequest',
				data: { roomId: 7, roomType: 1, requestId: 'req-throw' },
			} as never),
		).not.toThrow();

		const data = sent.find((f) => f.type === CC_BIND_RESULT)!.data as Record<string, unknown>;
		expect(data.requestId).toBe('req-throw');
		expect(String(data.error)).toContain('boom from bind');
		expect('launchCommand' in data).toBe(false);
	});
});
