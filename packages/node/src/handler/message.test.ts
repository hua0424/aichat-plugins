import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageHandler } from './message.js';
import type { HulaWSClient } from '../server/hula-ws.js';
import type { AgentDriver, AgentSession, AgentEvent } from '../agent/events.js';
import { WSReqType } from '../stream/protocol.js';
import type { ReceivedMessage } from '../stream/protocol.js';
import realAiclawGroupPush from './__fixtures__/real-aiclaw-group-push.json' assert { type: 'json' };
import { CcHeadlessDriver, type CcChild, type CcSpawnFn } from '../agent/cc/headless-driver.js';
import { InMemoryBindTokenStore } from '../agent/bind-token-store.js';
import { CcSessionRegistry } from '../agent/cc/sink.js';
import type { CcHeadlessSessionStore, StoredCcHeadlessSession } from '../agent/cc/headless-session-store.js';
import type { CcTranscriptRecord } from '../agent/cc/transcript.js';

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

/** 构造一条私聊文本消息（roomType=2），可选 name。 */
function dmMessage(
	roomId: number,
	fromUid: number,
	content: string,
	msgId: number,
	opts?: { name?: string },
): ReceivedMessage {
	return {
		fromUser: { uid: fromUid, name: opts?.name ?? 'user', userType: 1 },
		message: { id: msgId, roomId, type: 1, roomType: 2, body: { content } },
	} as unknown as ReceivedMessage;
}

// REQ-029 (#29): internals are keyed by opaque string roomId; helpers coerce numeric-literal args with String().
/** 读取指定房间的积累缓冲（白盒断言用） */
function getAccumulated(handler: MessageHandler, roomId: number | string): string[] {
	// @ts-expect-error 访问私有字段做白盒断言
	return handler.roomChannels.get(String(roomId))?.accumulatedMessages ?? [];
}

/** 读取指定房间的 pendingMessages（白盒断言用） */
function getPending(handler: MessageHandler, roomId: number | string): string[] {
	// @ts-expect-error 访问私有字段做白盒断言
	return handler.roomChannels.get(String(roomId))?.pendingMessages ?? [];
}

/** 读取内嵌 AntiLoopGuard（白盒断言用；getAiRoundCount 接受 number|string 并 String() 归一） */
function getGuard(handler: MessageHandler): { getAiRoundCount: (roomId: number | string) => number } {
	// @ts-expect-error 访问私有字段做白盒断言
	const guard = handler.antiLoopGuard as { getAiRoundCount: (roomId: string) => number };
	return { getAiRoundCount: (roomId) => guard.getAiRoundCount(String(roomId)) };
}

/** 读取指定房间的 antiLoopDelaying 标志（白盒断言用） */
function isDelaying(handler: MessageHandler, roomId: number | string): boolean {
	// @ts-expect-error 访问私有字段做白盒断言
	return handler.roomChannels.get(String(roomId))?.antiLoopDelaying === true;
}

/** 读取指定房间本批的 batchAiFromUid（白盒断言用；''=本批无对端 AI 触发消息） */
function getBatchAiFromUid(handler: MessageHandler, roomId: number | string): string {
	// @ts-expect-error 访问私有字段做白盒断言
	return handler.roomChannels.get(String(roomId))?.batchAiFromUid ?? '';
}

/** 读取内嵌 GroupConfigCache 中某房间的配置（白盒断言用） */
function getCachedConfig(
	handler: MessageHandler,
	roomId: number | string,
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
	return handler.groupConfigCache.get(SELF_UID, String(roomId));
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

// REQ-029 (#29): selfUid/roomId/uid are opaque strings end-to-end.
const SELF_UID = '999';

/** REQ-011 S3 e2e: temp workspace bases for the real CcHeadlessDriver, cleaned up after each test. */
const ccTmpDirs: string[] = [];
function ccTmpBase(): string {
	const d = mkdtempSync(join(tmpdir(), 'msg-cc-e2e-'));
	ccTmpDirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of ccTmpDirs.splice(0)) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}
});

describe('MessageHandler per-room isolation', () => {
	it('routes two rooms to their own sessionKey + roomId (no cross-room merge)', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws } = fakeWs();
		// 短 debounce，便于测试
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, () => {});

		handler.handle({ type: 'receiveMessage', data: humanMessage(1, 100, 'msg-room-1', 1) } as never);
		handler.handle({ type: 'receiveMessage', data: humanMessage(2, 200, 'msg-room-2', 2) } as never);

		await waitFor(() => calls.length >= 2);

		const byRoom = new Map(calls.map((c) => [c.context?.roomId, c]));
		expect(byRoom.get('1')?.sessionKey).toBe(`aiclaw-${SELF_UID}-room-1`);
		expect(byRoom.get('1')?.message).toBe('[HuLa 私聊]\n[user(100)]: msg-room-1');
		expect(byRoom.get('2')?.sessionKey).toBe(`aiclaw-${SELF_UID}-room-2`);
		expect(byRoom.get('2')?.message).toBe('[HuLa 私聊]\n[user(200)]: msg-room-2');
		// 没有把两房消息合并（各自 envelope 只含本房发送者与内容）
		expect(byRoom.get('1')?.message).not.toContain('msg-room-2');
		expect(byRoom.get('2')?.message).not.toContain('msg-room-1');
	});

	it('does not let room A pending queue leak into room B', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, () => {});

		// room 1 第一条 → 触发 thinking（adapter.chat 不结束，session 保持 active）
		handler.handle({ type: 'receiveMessage', data: humanMessage(1, 100, 'A1', 1) } as never);
		await waitFor(() => calls.length >= 1);
		expect(calls[0].context?.roomId).toBe('1');

		// room 1 thinking 进行中，再来一条 room 1 消息 → 进入 room1 pending（不触发新 chat）
		handler.handle({ type: 'receiveMessage', data: humanMessage(1, 100, 'A2', 2) } as never);

		// room 2 来消息 → 应独立触发自己的 chat，不被 room1 的 active thinking 阻塞
		handler.handle({ type: 'receiveMessage', data: humanMessage(2, 200, 'B1', 3) } as never);
		await waitFor(() => calls.some((c) => c.context?.roomId === '2'));

		const room2Call = calls.find((c) => c.context?.roomId === '2')!;
		expect(room2Call.message).toBe('[HuLa 私聊]\n[user(200)]: B1');
		// room1 的 pending（A2）不能混进 room2
		expect(room2Call.message).not.toContain('A2');

		// 结束 room1 的 thinking → 只 flush room1 的 pending（A2），不触碰 room2
		const room1Call = calls.find((c) => c.context?.roomId === '1')!;
		room1Call.callbacks.onThinkingEnd(100);
		await waitFor(() => calls.filter((c) => c.context?.roomId === '1').length >= 2);

		const room1Calls = calls.filter((c) => c.context?.roomId === '1');
		expect(room1Calls[1].message).toBe('[HuLa 私聊]\n[user(100)]: A2');
		// room2 仍然只有一次调用，没有被 room1 的 flush 误触发
		expect(calls.filter((c) => c.context?.roomId === '2').length).toBe(1);
	});

	it('ignores own messages and non-text messages', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, () => {});

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
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10000, maxWaitMs: 10000 }, () => {});

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
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, () => {});

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
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, () => {});

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
		const handler = new MessageHandler(ws, adapter, SELF_UID, apiClient, { waitMs: 10, maxWaitMs: 50 }, () => {});

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
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, () => {});

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
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, () => {});

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
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, () => {});

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
			const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 1, maxWaitMs: 1 }, () => {});

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
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, () => {});

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
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, () => {});

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
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, () => {});

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
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, () => {});

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
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, () => {});

		handler.handle({ type: 'receiveMessage', data: humanMessage(7, 100, 'hi', 1) } as never);
		await waitFor(() => calls.length >= 1);

		// 结束 thinking，pending 为空 → 通道应被回收
		calls[0].callbacks.onThinkingEnd(100);
		await new Promise((r) => setTimeout(r, 20));

		// @ts-expect-error 访问私有字段做白盒断言
		expect(handler.roomChannels.has('7')).toBe(false);
	});
});

describe('MessageHandler S5: 群聊 @ 触发 + 惰性积累', () => {
	it('group + mention_required + @bot → triggers the agent loop', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, () => {});
		setGroupConfig(handler, 1, { mentionRequired: true });

		handler.handle({
			type: 'receiveMessage',
			data: groupMessage(1, 100, 'hey bot', 1, { atUidList: [SELF_UID] }),
		} as never);

		await waitFor(() => calls.length >= 1);
		expect(calls[0].context?.roomId).toBe('1');
		expect(calls[0].message).toBe('[HuLa 群聊]\n[user(100)]: hey bot');
		expect(getAccumulated(handler, 1).length).toBe(0);
	});

	it('REQ-009 #85: group openSession chatContext carries workspaceDir + account from cache', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws } = fakeWs();
		const openSession = (adapter as unknown as { openSession: ReturnType<typeof vi.fn> }).openSession;
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, () => {});
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

	it('#132: cc driver openSession chatContext carries selfName resolved from apiClient.getMemberInfo (cached)', async () => {
		const { adapter, calls } = fakeAdapter();
		(adapter as unknown as { type: string }).type = 'cc';
		const { ws } = fakeWs();
		const openSession = (adapter as unknown as { openSession: ReturnType<typeof vi.fn> }).openSession;
		const getMemberInfo = vi.fn(async () => ({ uid: SELF_UID, name: 'CCTestAI', account: 'cctest' }));
		const apiClient = { getMemberInfo } as unknown as import('../api/hula-api.js').HulaApiClient;
		const handler = new MessageHandler(ws, adapter, SELF_UID, apiClient, { waitMs: 10, maxWaitMs: 50 }, () => {});

		handler.handle({ type: 'receiveMessage', data: humanMessage(1, 100, 'hi cc', 1) } as never);
		await waitFor(() => calls.length >= 1);
		// a turn in a DIFFERENT room must NOT re-fetch — the name is resolved once + cached
		handler.handle({ type: 'receiveMessage', data: humanMessage(2, 100, 'hi again', 2) } as never);
		await waitFor(() => calls.length >= 2);

		const ctx = openSession.mock.calls[0][0].chatContext as { selfName?: string };
		expect(ctx.selfName).toBe('CCTestAI');
		expect(getMemberInfo).toHaveBeenCalledWith(SELF_UID);
		expect(getMemberInfo).toHaveBeenCalledTimes(1); // cached across turns
	});

	it('#132: non-cc driver does NOT fetch getMemberInfo and passes no selfName', async () => {
		const { adapter, calls } = fakeAdapter(); // type: 'fake'
		const { ws } = fakeWs();
		const openSession = (adapter as unknown as { openSession: ReturnType<typeof vi.fn> }).openSession;
		const getMemberInfo = vi.fn(async () => ({ name: 'CCTestAI' }));
		const apiClient = { getMemberInfo } as unknown as import('../api/hula-api.js').HulaApiClient;
		const handler = new MessageHandler(ws, adapter, SELF_UID, apiClient, { waitMs: 10, maxWaitMs: 50 }, () => {});

		handler.handle({ type: 'receiveMessage', data: humanMessage(1, 100, 'hi', 1) } as never);
		await waitFor(() => calls.length >= 1);

		expect(getMemberInfo).not.toHaveBeenCalled();
		const ctx = openSession.mock.calls[0][0].chatContext as { selfName?: string };
		expect(ctx.selfName).toBeUndefined();
	});

	// REQ-146 (#146) sign-on-access: media messages resolve a SHORT-lived signed download URL via
	// apiClient.signDownload(msgId) and inject it into the turn — and the URL must NEVER reach node logs.
	it('REQ-146: media (type 3) resolves signDownload(msgId), injects the signed url, and never logs it', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws } = fakeWs();
		const SIGNED = 'http://minio/tmp/chat/55_pic.png?X-Amz-Signature=short-lived-secret';
		const signDownload = vi.fn(async () => ({ url: SIGNED, expiresIn: 300 }));
		const apiClient = { signDownload } as unknown as import('../api/hula-api.js').HulaApiClient;
		const handler = new MessageHandler(ws, adapter, SELF_UID, apiClient, { waitMs: 10, maxWaitMs: 50 }, () => {});

		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		// roomType=2 (private) → always trigger-eligible. body.url is the now-unusable old link.
		const media = {
			fromUser: { uid: 100, name: 'user', userType: 1 },
			message: {
				id: 55,
				roomId: 5,
				type: 3,
				roomType: 2,
				body: { url: 'http://minio/OLD-7day.png?stale=1', size: 9, mime: 'image/png', fileName: 'pic.png' },
			},
		} as unknown as ReceivedMessage;

		handler.handle({ type: 'receiveMessage', data: media } as never);
		await waitFor(() => calls.length >= 1);

		// signDownload called with the raw msgId; the signed url (not the stale one) reaches the agent turn.
		expect(signDownload).toHaveBeenCalledWith(55);
		expect(calls[0].message).toContain(SIGNED);
		expect(calls[0].message).not.toContain('OLD-7day');

		// the short-lived signed url must never appear in any console output.
		const allLogs = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errSpy.mock.calls].flat().join(' ');
		expect(allLogs).not.toContain(SIGNED);

		logSpy.mockRestore();
		warnSpy.mockRestore();
		errSpy.mockRestore();
	});

	it('REQ-146: signDownload throws → falls back to body.url, no crash, url still not logged', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws } = fakeWs();
		const signDownload = vi.fn(async () => {
			throw new Error('HuLa API error: 403 forbidden');
		});
		const apiClient = { signDownload } as unknown as import('../api/hula-api.js').HulaApiClient;
		const handler = new MessageHandler(ws, adapter, SELF_UID, apiClient, { waitMs: 10, maxWaitMs: 50 }, () => {});

		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		const FALLBACK = 'http://minio/pre-deploy.png?legacy=1';
		const media = {
			fromUser: { uid: 100, name: 'user', userType: 1 },
			message: { id: 56, roomId: 5, type: 3, roomType: 2, body: { url: FALLBACK, size: 9, fileName: 'p.png' } },
		} as unknown as ReceivedMessage;

		handler.handle({ type: 'receiveMessage', data: media } as never);
		await waitFor(() => calls.length >= 1);

		expect(signDownload).toHaveBeenCalledWith(56);
		// falls back to the embedded (old) url so the pre-deploy message still works.
		expect(calls[0].message).toContain(FALLBACK);
		// even the fallback url must not be printed (envelope/preview logs redact url: lines).
		const allLogs = [...logSpy.mock.calls, ...warnSpy.mock.calls].flat().join(' ');
		expect(allLogs).not.toContain(FALLBACK);

		logSpy.mockRestore();
		warnSpy.mockRestore();
	});

	it('group + mention_required + NO @bot → NOT triggered, message accumulated', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, () => {});
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
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, () => {});
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
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, () => {});
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
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, () => {});

		handler.handle({
			type: 'receiveMessage',
			data: { fromUser: { uid: 100, name: 'u', userType: 1 }, message: { id: 1, roomId: 3, type: 1, roomType: 2, body: { content: 'dm hi' } } },
		} as never);

		await waitFor(() => calls.length >= 1);
		expect(calls[0].message).toBe('[HuLa 私聊]\n[u(100)]: dm hi');
		expect(getAccumulated(handler, 3).length).toBe(0);
	});

	it('group + mention_required=0 (cached config) → every message triggers', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, () => {});
		setGroupConfig(handler, 1, { mentionRequired: false });

		handler.handle({
			type: 'receiveMessage',
			data: groupMessage(1, 100, 'no mention needed', 1),
		} as never);

		await waitFor(() => calls.length >= 1);
		expect(calls[0].message).toBe('[HuLa 群聊]\n[user(100)]: no mention needed');
		expect(getAccumulated(handler, 1).length).toBe(0);
	});

	// NOTE: 积累标注 `[name(uid)]:` 真读 fromUser.name，但真实 server 不下发 name（见
	// __fixtures__/real-aiclaw-group-push.json）→ 线上标注会退化成 `[unknown(uid)]:`。这是与防循环
	// 无关的独立**外观**缺口，超出本 issue 范围；此处仍用写死 name 的 groupMessage，留作后续 issue 跟进。
	it('annotation format is exactly [name(uid)]: content', async () => {
		const { adapter } = fakeAdapter();
		const { ws } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, () => {});
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
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, () => {});
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

		// REQ-013 S1: the unified inbound-attribution envelope (same for all four drivers). Group header +
		// accumulated un-@ lines + the trigger message's own attributed line, in order.
		const sent = calls[0].message;
		expect(sent).toBe('[HuLa 群聊]\n[alice(100)]: first\n[bob(101)]: second\n[dave(102)]: hey bot');
		// 历史在当前消息之前
		expect(sent.indexOf('[alice(100)]: first')).toBeLessThan(sent.indexOf('hey bot'));
		// 注入后缓冲清空
		expect(getAccumulated(handler, 1).length).toBe(0);
	});

	it('TIMING: with thinking ACTIVE, un-@ group message is accumulated, NOT queued to pendingMessages, and does NOT trigger after thinking ends', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, () => {});
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
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, () => {});
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
			const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 1, maxWaitMs: 1 }, () => {});
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
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, () => {});
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
			const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 1, maxWaitMs: 1 }, () => {});
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
			const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 1, maxWaitMs: 1 }, () => {});
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
			const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 1, maxWaitMs: 1 }, () => {});
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
			const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 1, maxWaitMs: 1 }, () => {});
			setGroupConfig(handler, 1, { mentionRequired: false, respondToAi: true });

			handler.handle({ type: 'receiveMessage', data: aiMessage(1, 200, 'ai-1', 1) } as never);
			await vi.advanceTimersByTimeAsync(5);

			// 立即进入一次 chat，无退避
			expect(calls.length).toBe(1);
			expect(calls[0].message).toBe('[HuLa 私聊]\n[unknown(200)]: ai-1');
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
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, () => {});
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
		expect(getBatchAiFromUid(handler, 1)).toBe('');
		expect(guard.getAiRoundCount(1)).toBe(0);
	});

	it('delay window does NOT drop messages: a message arriving during antiLoopDelaying is queued and reaches a later trigger', async () => {
		vi.useFakeTimers();
		try {
			const { adapter, calls } = fakeAdapter();
			const { ws } = fakeWs();
			const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 1, maxWaitMs: 1 }, () => {});
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
			const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 1, maxWaitMs: 1 }, () => {});
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
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, () => {});
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
			const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 1, maxWaitMs: 1 }, () => {});
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
		const handler = new MessageHandler(ws, adapter, SELF_UID, apiClient, undefined, () => {});

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
		const handler = new MessageHandler(ws, adapter, SELF_UID, apiClient, undefined, () => {});

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
		const handler = new MessageHandler(ws, adapter, SELF_UID, apiClient, undefined, () => {});

		await expect(handler.prewarmGroupConfigs()).resolves.toBeUndefined();
		await expect(handler.prewarmGroupConfigs()).resolves.toBeUndefined();

		expect(listSelfGroupConfigs).toHaveBeenCalledTimes(2);
		const c10 = getCachedConfig(handler, 10);
		expect(c10).toBeDefined();
		expect(c10!.mentionRequired).toBe(true);
		expect(c10!.rateLimitPerMinute).toBe(5);
	});

	// BL-015 / #140: 契约翻转 —— list API 抛错时 prewarm **抛出**（交给调用方 retryAsync 重试 + 记日志），
	// 但仍不破坏已有 cache（cache 只在成功循环里写）。一条测试串起完整故事：
	// 成功预热填充 cache → 后续预热在 Nacos 重注册窗口内抛错时 REJECT → 两种写路径的旧值（prewarm 成功项 +
	// groupConfigChange 预置项）都天然保留。
	it('prewarmThrowsButPreservesCache: 成功预热填充 cache → 后续预热抛错 REJECT，且旧 cache 不被清空', async () => {
		const { adapter } = fakeAdapter();
		const { ws } = fakeWs();
		let shouldThrow = false;
		const { apiClient } = fakeApiClient(async () => {
			if (shouldThrow) throw new Error('nacos re-register window');
			return [{ roomId: 42, mentionRequired: 1, respondToAi: 1, rateLimitPerMinute: 5, dailyLimit: 100 }];
		});
		const handler = new MessageHandler(ws, adapter, SELF_UID, apiClient, undefined, () => {});

		// 另经 groupConfigChange 预置一条已有 cache（不同写路径，一并验证不被清空）。
		setGroupConfig(handler, 7, { mentionRequired: false, rateLimitPerMinute: 9 });

		// 首次预热成功 → 房间 42 从 list API 进入 cache。
		await handler.prewarmGroupConfigs();
		const cached42 = getCachedConfig(handler, 42);
		expect(cached42).toBeDefined();
		expect(cached42!.rateLimitPerMinute).toBe(5);

		// 后续预热在 Nacos 重注册窗口内失败 → 必须 REJECT（交给调用方 retryAsync）；旧行为是吞掉。
		shouldThrow = true;
		await expect(handler.prewarmGroupConfigs()).rejects.toThrow('nacos re-register window');

		// 抛出后两条旧值天然保留（cache 只在成功循环里写）。
		expect(getCachedConfig(handler, 42)).toEqual(cached42);
		const c7 = getCachedConfig(handler, 7);
		expect(c7).toBeDefined();
		expect(c7!.mentionRequired).toBe(false);
		expect(c7!.rateLimitPerMinute).toBe(9);
	});

	it('prewarmNoApiClientIsNoop: apiClient 为 null 时不抛、cache 空', async () => {
		const { adapter } = fakeAdapter();
		const { ws } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, undefined, () => {});

		await expect(handler.prewarmGroupConfigs()).resolves.toBeUndefined();

		expect(getCachedConfig(handler, 10)).toBeUndefined();
	});
});

// ─── REQ-011 S2: cc is now node-driven → the STANDARD supervised path ───

describe('MessageHandler REQ-011 S2: cc drives the standard node-driven path', () => {
	/** A cc-typed adapter (like CcHeadlessDriver) → standard node-driven path applies. */
	function ccHeadlessAdapter() {
		const { adapter, calls } = fakeAdapter();
		(adapter as unknown as { type: string }).type = 'cc';
		return { adapter, calls };
	}

	it('an inbound cc message opens a session + sends THINKING_START (no channelPush surface anymore)', async () => {
		const { adapter, calls } = ccHeadlessAdapter();
		const { ws, sent } = fakeWs();
		// NOTE: the constructor no longer accepts a channelPush arg — cc uses the standard path.
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, () => {});

		handler.handle({ type: 'receiveMessage', data: humanMessage(1, 100, 'hi cc', 1) } as never);
		await waitFor(() => calls.length >= 1);

		expect(calls[0].message).toBe('[HuLa 私聊]\n[user(100)]: hi cc');
		expect((adapter as unknown as { openSession: ReturnType<typeof vi.fn> }).openSession).toHaveBeenCalled();
		expect(sent.filter((f) => f.type === WSReqType.THINKING_START).length).toBe(1);
	});

	it('a cc turn streams thinking (bridged) + done → THINKING_END complete, exactly like the other drivers', async () => {
		const { adapter, calls } = ccHeadlessAdapter();
		const { ws, sent } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, () => {});

		handler.handle({ type: 'receiveMessage', data: humanMessage(1, 100, 'hi cc', 1) } as never);
		await waitFor(() => calls.length >= 1);

		// bridged hook thinking, then done — the same AgentEvent stream the standard path consumes.
		calls[0].callbacks.onThinkingDelta('cc reasoning');
		calls[0].callbacks.onThinkingEnd(5);
		await calls[0].flush();

		const end = sent.find((f) => f.type === WSReqType.THINKING_END);
		expect(end).toBeDefined();
		expect((end!.data as Record<string, unknown>).content).toBe('cc reasoning');
		expect((end!.data as Record<string, unknown>).status).toBe('complete');
	});
});

// ─── REQ-011 S3: sender attribution wiring + data-routing + group @-parity ───

describe('MessageHandler REQ-011 S3: cc attribution wiring + data-routing + group @-parity', () => {
	/** A cc-typed fake adapter — the STANDARD node-driven path applies, like CcHeadlessDriver. */
	function ccAdapter() {
		const { adapter, calls } = fakeAdapter();
		(adapter as unknown as { type: string }).type = 'cc';
		return { adapter, calls };
	}
	const openSessionOf = (adapter: unknown) => (adapter as { openSession: ReturnType<typeof vi.fn> }).openSession;

	it('AC5: a cc driver gets the UNIFIED envelope containing the trigger sender`s [name(uid)] line', async () => {
		const { adapter, calls } = ccAdapter();
		const openSession = openSessionOf(adapter);
		const { ws } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, () => {});
		setGroupConfig(handler, 1, { mentionRequired: true });

		// two un-@ messages accumulate (un-@ group context)
		handler.handle({ type: 'receiveMessage', data: groupMessage(1, 100, 'first', 1, { name: 'alice' }) } as never);
		handler.handle({ type: 'receiveMessage', data: groupMessage(1, 101, 'second', 2, { name: 'bob' }) } as never);
		await new Promise((r) => setTimeout(r, 40));
		// then an @-message triggers
		handler.handle({ type: 'receiveMessage', data: groupMessage(1, 102, 'hey bot', 3, { atUidList: [SELF_UID], name: 'dave' }) } as never);
		await waitFor(() => calls.length >= 1);

		// REQ-013 S1: the driver receives the UNIFIED attribution envelope (built at the handler common
		// layer), NOT a raw message — the same envelope every driver now gets.
		expect(calls[0].message).toBe('[HuLa 群聊]\n[alice(100)]: first\n[bob(101)]: second\n[dave(102)]: hey bot');
		// the generic per-turn attribution fields are no longer forwarded via chatContext (envelope is built upstream).
		const ctx = openSession.mock.calls[0][0].chatContext as { fromName?: string; accumulated?: string[] };
		expect(ctx.fromName).toBeUndefined();
		expect(ctx.accumulated).toBeUndefined();
	});

	it('AC2: a NON-cc driver gets the SAME unified envelope (no cc-vs-others ternary anymore)', async () => {
		const { adapter, calls } = fakeAdapter(); // type 'fake' (not cc)
		const { ws } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, () => {});
		setGroupConfig(handler, 1, { mentionRequired: true });

		handler.handle({ type: 'receiveMessage', data: groupMessage(1, 100, 'first', 1, { name: 'alice' }) } as never);
		await new Promise((r) => setTimeout(r, 40));
		handler.handle({ type: 'receiveMessage', data: groupMessage(1, 102, 'hey bot', 3, { atUidList: [SELF_UID], name: 'dave' }) } as never);
		await waitFor(() => calls.length >= 1);

		// REQ-013 S1: unified — identical to what the cc driver gets; the old `[群聊上下文]/[当前消息]` form is gone.
		expect(calls[0].message).toBe('[HuLa 群聊]\n[alice(100)]: first\n[dave(102)]: hey bot');
		expect(calls[0].message).not.toContain('群聊上下文');
	});

	it('AC5: DM → the unified `[HuLa 私聊]` envelope carries the sender`s [name(uid)] line', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, () => {});

		// a direct message (roomType=2) always triggers, no @ needed.
		handler.handle({ type: 'receiveMessage', data: dmMessage(9, 100, '你好', 1, { name: '小明' }) } as never);
		await waitFor(() => calls.length >= 1);

		expect(calls[0].message).toBe('[HuLa 私聊]\n[小明(100)]: 你好');
	});

	it('AC5: logs a single `envelope→driver` line with the assembled envelope (newlines escaped)', async () => {
		const { adapter } = fakeAdapter();
		const { ws } = fakeWs();
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		try {
			const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, () => {});
			handler.handle({ type: 'receiveMessage', data: dmMessage(9, 100, '你好', 1, { name: '小明' }) } as never);
			await waitFor(() => logSpy.mock.calls.some((c) => String(c[0]).includes('envelope→driver')));

			const line = logSpy.mock.calls.map((c) => String(c[0])).find((s) => s.includes('envelope→driver'))!;
			// structural evidence (AC5): sender name(uid) + the room header + attribution line, newlines escaped to one line.
			expect(line).toContain('from=小明(100)');
			expect(line).toContain('[HuLa 私聊]\\n[小明(100)]: 你好');
			expect(line).not.toContain('\n'); // the envelope's newline must be escaped, keeping it grep-able
		} finally {
			logSpy.mockRestore();
		}
	});

	it('parity: a cc un-@ group message is accumulated and does NOT trigger (guard inherited, no bypass)', async () => {
		const { adapter, calls } = ccAdapter();
		const { ws } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, () => {});
		setGroupConfig(handler, 1, { mentionRequired: true });

		handler.handle({ type: 'receiveMessage', data: groupMessage(1, 100, 'just chatting', 1, { name: 'alice' }) } as never);
		await new Promise((r) => setTimeout(r, 40));

		expect(calls.length).toBe(0);
		expect(getAccumulated(handler, 1)).toEqual(['[alice(100)]: just chatting']);
		expect(getPending(handler, 1).length).toBe(0);
	});

	it('parity: a cc @-group message triggers openSession/send (same @-gate as the other drivers)', async () => {
		const { adapter, calls } = ccAdapter();
		const openSession = openSessionOf(adapter);
		const { ws, sent } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, () => {});
		setGroupConfig(handler, 1, { mentionRequired: true });

		handler.handle({ type: 'receiveMessage', data: groupMessage(1, 100, 'hey bot', 1, { atUidList: [SELF_UID], name: 'dave' }) } as never);
		await waitFor(() => calls.length >= 1);

		expect(openSession).toHaveBeenCalled();
		expect(calls[0].message).toBe('[HuLa 群聊]\n[dave(100)]: hey bot');
		expect(sent.filter((f) => f.type === WSReqType.THINKING_START).length).toBe(1);
	});

	it('parity: cc skip-self is inherited (own message neither triggers nor accumulates)', async () => {
		const { adapter, calls } = ccAdapter();
		const { ws } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, () => {});
		setGroupConfig(handler, 1, { mentionRequired: true });

		// a message FROM self (uid === SELF_UID) — dropped at step 3 before any @-gate / accumulate.
		handler.handle({ type: 'receiveMessage', data: groupMessage(1, SELF_UID, 'echo of myself', 1, { atUidList: [SELF_UID] }) } as never);
		await new Promise((r) => setTimeout(r, 40));

		expect(calls.length).toBe(0);
		expect(getAccumulated(handler, 1).length).toBe(0);
	});

	// e2e through the REAL CcHeadlessDriver: the attributed transcript is assembled IN the driver from the
	// handler's raw message + chatContext.fromName/accumulated → the spawned stdin envelope proves the wiring.
	function ccE2eSpawn() {
		const stdinWrites: string[] = [];
		let spawnCall: { command: string; args: readonly string[] } | null = null;
		const endCbs: Array<() => void> = [];
		const child: CcChild = {
			pid: 5252,
			stdin: { write: (c: string) => void stdinWrites.push(c), end: () => {} },
			stdout: {
				on: (event: string, listener: (...a: never[]) => void) => {
					if (event === 'end' || event === 'close') endCbs.push(listener as () => void);
				},
			} as CcChild['stdout'],
			stderr: { on: () => {} } as CcChild['stderr'],
			on: () => {},
			kill: () => true,
		};
		const spawn: CcSpawnFn = (command, args) => {
			spawnCall = { command, args };
			return child;
		};
		return { spawn, stdinWrites, endStdout: () => endCbs.forEach((cb) => cb()), get spawnCall() { return spawnCall; } };
	}
	function memCcStore(): CcHeadlessSessionStore {
		const map = new Map<string, StoredCcHeadlessSession>();
		return { get: (k) => map.get(k), set: (k, v) => void map.set(k, v), delete: (k) => void map.delete(k) };
	}

	it('e2e: cc group @ through the REAL CcHeadlessDriver → spawned stdin envelope is the attributed [HuLa 群聊] transcript', async () => {
		const fs = ccE2eSpawn();
		const transcriptRecords: CcTranscriptRecord[] = [];
		const driver = new CcHeadlessDriver({
			workspaceBase: ccTmpBase(),
			brokerPort: 9100,
			sessionStore: memCcStore(),
			bindTokens: new InMemoryBindTokenStore(),
			registry: new CcSessionRegistry(),
			transcript: { append: (_k, r) => void transcriptRecords.push(r) },
			spawn: fs.spawn,
			firstEventTimeoutMs: 1000,
			drainMs: 5,
			killGraceMs: 20,
		});
		const { ws } = fakeWs();
		const handler = new MessageHandler(ws, driver, SELF_UID, undefined, { waitMs: 5, maxWaitMs: 30 }, () => {});
		setGroupConfig(handler, 1, { mentionRequired: true });

		// one un-@ accumulates, then an @-message triggers the real spawn.
		handler.handle({ type: 'receiveMessage', data: groupMessage(1, 100, 'first', 1, { name: 'alice' }) } as never);
		await new Promise((r) => setTimeout(r, 20));
		handler.handle({ type: 'receiveMessage', data: groupMessage(1, 102, 'hey bot', 3, { atUidList: [SELF_UID], name: 'dave' }) } as never);
		await waitFor(() => fs.spawnCall !== null && fs.stdinWrites.length > 0);

		const text = JSON.parse(fs.stdinWrites[0].trim()).message.content[0].text as string;
		expect(text).toBe('[HuLa 群聊]\n[alice(100)]: first\n[dave(102)]: hey bot');
		// the inbound transcript record carries the same attributed text
		expect(transcriptRecords.find((r) => r.kind === 'inbound')?.text).toBe(text);

		// finish the turn (EOF backstop) so no timer/session dangles.
		fs.endStdout();
		await waitFor(() => getThinkingSession(handler, `aiclaw-${SELF_UID}-room-1`) === undefined);
		handler.destroy();
	});
});

// ─── REQ-029 (#29): roomId > 2^53 stays an EXACT opaque string end-to-end (inbound → outbound) ───

describe('MessageHandler REQ-029 (#29): >2^53 roomId precision', () => {
	it('inbound roomId > 2^53 → THINKING_START carries the EXACT string (untruncated, not Number()d)', async () => {
		const { adapter, calls } = fakeAdapter();
		const { ws, sent } = fakeWs();
		const handler = new MessageHandler(ws, adapter, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, () => {});

		// Number('9007199254740993') === 9007199254740992 — a Number()d roomId would corrupt routing.
		const bigRoom = '9007199254740993';
		// private (roomType=2) → always triggers
		handler.handle({ type: 'receiveMessage', data: humanMessage(bigRoom, '100', 'hi', '77') } as never);
		await waitFor(() => calls.length >= 1);

		// outbound routing preserved: the driver session is bound to the EXACT room string.
		expect(calls[0].context?.roomId).toBe(bigRoom);
		expect(calls[0].sessionKey).toBe(`aiclaw-${SELF_UID}-room-${bigRoom}`);

		// the outbound THINKING_START payload carries the exact string, never the corrupted number.
		const start = sent.find((f) => f.type === WSReqType.THINKING_START)!.data as Record<string, unknown>;
		expect(start.roomId).toBe(bigRoom);
		expect(start.roomId).not.toBe(9007199254740992);
	});
});
