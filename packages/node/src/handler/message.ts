import type { WSResponse, ReceivedMessage, ThinkingStartDTO, ThinkingEndDTO, GroupConfigChangeDTO } from '../stream/protocol.js';
import type { HulaWSClient } from '../server/hula-ws.js';
import { WSReqType } from '../stream/protocol.js';
import type { ClawAdapter, ChatContext, ThinkingCallbacks } from '../claw/interface.js';
import { MessageDebouncer } from '../utils/debounce.js';
import { AntiLoopGuard } from './anti-loop.js';
import { GroupConfigCache } from './group-config-cache.js';
import type { HulaApiClient } from '../api/hula-api.js';

/**
 * REQ-004: Thinking 会话状态
 */
interface ThinkingSession {
	/** sessionKey: aiclaw-{uid}-room-{roomId} */
	sessionKey: string;
	/** server 生成的 thinking 记录 ID（START 广播后回填） */
	thinkingId: string;
	/** 触发消息的 msgId */
	triggerMsgId: string;
	/** 思考开始时间戳 */
	startTime: number;
	/** THINKING_DELTA 序列号 */
	seq: number;
	/** 思考内容累计（用于日志/debug） */
	accumulatedContent: string;
	/** 超时清理定时器 ID */
	timeoutId?: ReturnType<typeof setTimeout>;
	/** thinkingId 回填前缓存的 delta（防 race condition） */
	pendingDeltas: Array<{ chunk: string; seq: number }>;
	/** 是否已 finalized（防止 onThinkingEnd / handleThinkingEndBroadcast 双重清理） */
	finalized: boolean;
	/**
	 * REQ-004 S3: 本轮终结动作账本。
	 * 'sent'：观测到一次 send（send-wins，一旦 sent 不再被后到的 skip 覆盖）；
	 * 'skipped'：观测到 skip 且尚未 sent；
	 * 'none'：未观测到任何终结动作（onThinkingEnd 时回退为 auto-skip）。
	 */
	terminalAction: 'sent' | 'skipped' | 'none';
	/** REQ-004 S3: skip 原因（显式 skip 带的 reason，或 auto-skip 的占位原因） */
	skipReason?: string;
}

/**
 * 最近一次收到的用户消息上下文
 */
interface LastMessageContext {
	roomId: number;
	fromUid: number;
	msgId: string;
}

/**
 * REQ-004 S2: 单房间的处理状态。
 * debounce 队列 / 待处理消息 / 触发上下文均按房间隔离，杜绝跨房间污染。
 */
interface RoomChannel {
	debouncer: MessageDebouncer;
	pendingMessages: string[];
	lastCtx: LastMessageContext;
}

/**
 * 消息处理器（REQ-004 Agent Loop 模型）
 * 接收用户消息 → ACK → 去重 → 触发 agent loop → THINKING 流式输出
 */
export class MessageHandler {
	private ws: HulaWSClient;
	private adapter: ClawAdapter;
	private selfUid: number;

	// REQ-004: 替换 streaming boolean 为 thinkingSessions Map
	private thinkingSessions = new Map<string, ThinkingSession>();

	// REQ-004 S2: 按房间隔离的处理状态（debouncer / pendingMessages / lastCtx）
	private roomChannels = new Map<number, RoomChannel>();

	/**
	 * 已处理的 msgId 集合（防重复推送）。
	 * 全局去重是有意为之：msgId 在所有房间间全局唯一，无需按房间隔离；
	 * 上限 500、FIFO 淘汰最旧，避免无界增长。
	 */
	private processedMsgIds = new Set<string>();

	/** thinking session 超时时间（5 分钟） */
	private readonly THINKING_SESSION_TIMEOUT_MS = 5 * 60 * 1000;

	// REQ-004 M3: 防循环守卫 + 群配置缓存
	private antiLoopGuard: AntiLoopGuard;
	private groupConfigCache: GroupConfigCache;

	// REQ-004 M3: 内嵌 HulaApiClient（仅用于 autoReply / CLI）
	private apiClient: HulaApiClient | null = null;

	/** debounce 配置（可注入，便于测试） */
	private readonly debounceOptions?: { waitMs?: number; maxCount?: number; maxWaitMs?: number };

	constructor(
		ws: HulaWSClient,
		adapter: ClawAdapter,
		selfUid: number,
		apiClient?: HulaApiClient,
		debounceOptions?: { waitMs?: number; maxCount?: number; maxWaitMs?: number },
	) {
		this.ws = ws;
		this.adapter = adapter;
		this.selfUid = selfUid;
		this.antiLoopGuard = new AntiLoopGuard();
		this.groupConfigCache = new GroupConfigCache();
		this.apiClient = apiClient || null;
		this.debounceOptions = debounceOptions;
	}

	/**
	 * REQ-004 S2: 获取/创建指定房间的处理通道。
	 * 每个房间有独立的 debouncer，flush 时只触发该房间的 agent loop。
	 */
	private getRoomChannel(roomId: number): RoomChannel {
		let channel = this.roomChannels.get(roomId);
		if (!channel) {
			const debouncer = new MessageDebouncer((merged) => {
				this.triggerAgentLoop(roomId, merged).catch((err) => {
					console.error(`[handler] triggerAgentLoop unhandled error (room ${roomId}):`, err.message);
				});
			}, this.debounceOptions);
			channel = { debouncer, pendingMessages: [], lastCtx: { roomId, fromUid: 0, msgId: '' } };
			this.roomChannels.set(roomId, channel);
		}
		return channel;
	}

	handle(msg: WSResponse): void {
		switch (msg.type) {
			case 'receiveMessage':
				this.handleReceiveMessage(msg.data as ReceivedMessage);
				break;
			case 'thinkingStart':
				this.handleThinkingStartBroadcast(msg.data as ThinkingStartDTO);
				break;
			case 'groupConfigChange':
				this.handleGroupConfigChange(msg.data as GroupConfigChangeDTO);
				break;
			case 'thinkingEnd':
				this.handleThinkingEndBroadcast(msg.data as ThinkingEndDTO);
				break;
			case 'tokenExpired':
				console.error('[handler] Token expired, shutting down...');
				process.exit(1);
				break;
			case 'aiclawAuthRequest':
				console.warn('[handler] Machine code auth request received. Waiting for owner approval...');
				break;
			default:
				break;
		}
	}

	private handleReceiveMessage(data: ReceivedMessage): void {
		const msgId = String(data.message.id);

		// 1. 发送 ACK
		this.ws.send(WSReqType.ACK, {
			msgId: Number(msgId),
			timestamp: Date.now(),
		});

		// 2. 去重
		if (this.processedMsgIds.has(msgId)) {
			return;
		}
		this.processedMsgIds.add(msgId);
		if (this.processedMsgIds.size > 500) {
			const oldest = this.processedMsgIds.values().next().value;
			if (oldest) this.processedMsgIds.delete(oldest);
		}

		// 3. 忽略自己发的消息
		if (String(data.fromUser.uid) === String(this.selfUid)) return;
		// 只处理文本消息 (type=1)
		if (data.message.type !== 1) return;

		const content = data.message.body?.content;
		if (!content?.trim()) return;

		const roomId = Number(data.message.roomId);
		const fromUid = Number(data.fromUser.uid);
		const isFromAi = data.fromUser.userType === 4; // 4 = AICLAW

		// 4. 【M3】跳过 autoReply 消息
		const extra = (data.message as Record<string, unknown>).extra as Record<string, unknown> | undefined;
		if (extra?.autoReply === true) {
			console.log(`[handler] Skipping autoReply message msgId=${msgId}`);
			return;
		}

		// 5. 【M3】AI 互触发开关检查
		if (isFromAi) {
			const config = this.groupConfigCache.get(this.selfUid, roomId);
			if (!config?.respondToAi) {
				console.log(`[handler] Skipping AI message (respondToAi=false) msgId=${msgId}`);
				return;
			}
		}

		// 缓存消息上下文（按房间隔离）
		const channel = this.getRoomChannel(roomId);
		channel.lastCtx = { roomId, fromUid, msgId };

		console.log(`[handler] Message from ${data.fromUser.name ?? 'unknown'}(${data.fromUser.uid}) in room ${roomId}: ${content.substring(0, 50)}...`);

		const sessionKey = `aiclaw-${this.selfUid}-room-${roomId}`;

		// 6. 检查 thinking session 是否已存在
		if (this.thinkingSessions.has(sessionKey)) {
			channel.pendingMessages.push(content);
			console.log(`[handler] Message queued (thinking active) room=${roomId}, pending: ${channel.pendingMessages.length}`);
			return;
		}

		// 7. 【M3】防循环检查
		const guardResult = this.antiLoopGuard.check({
			roomId,
			fromUid,
			selfUid: this.selfUid,
			content,
			isFromAi,
		});

		if (guardResult.action === 'block') {
			console.log(`[anti-loop] block roomId=${roomId} reason=${guardResult.reason}`);
			this.sendAutoReply(roomId, guardResult.reason ?? 'rate limited');
			return;
		}

		if (guardResult.action === 'delay') {
			console.log(`[anti-loop] delay roomId=${roomId} delayMs=${guardResult.delayMs} aiRoundCount=${this.antiLoopGuard.getAiRoundCount(roomId)}`);
			setTimeout(() => {
				this.getRoomChannel(roomId).debouncer.push(content);
			}, guardResult.delayMs);
			return;
		}

		// 正常触发
		channel.debouncer.push(content);
	}

	private async triggerAgentLoop(roomId: number, message: string): Promise<void> {
		if (!this.ws.isConnected) {
			console.warn('[handler] WS not connected, dropping AI request');
			return;
		}

		const channel = this.roomChannels.get(roomId);
		if (!channel || !channel.lastCtx.msgId) {
			console.warn(`[handler] No message context for room ${roomId}, dropping AI request`);
			return;
		}

		const { msgId } = channel.lastCtx;
		const sessionKey = `aiclaw-${this.selfUid}-room-${roomId}`;

		// 并发防护
		if (this.thinkingSessions.has(sessionKey)) {
			console.warn(`[handler] Thinking session already active for ${sessionKey}`);
			return;
		}

		// 创建 thinking session（thinkingId 初始为空，等 server 广播回填）
		const session: ThinkingSession = {
			sessionKey,
			thinkingId: '',
			triggerMsgId: msgId,
			startTime: Date.now(),
			seq: 0,
			accumulatedContent: '',
			pendingDeltas: [],
			finalized: false,
			terminalAction: 'none',
		};

		// 设置 5 分钟超时定时器（P-M2-3）
		session.timeoutId = setTimeout(() => {
			if (session.finalized) return;
			session.finalized = true;
			console.error(`[thinking] timeout session=${sessionKey} after ${this.THINKING_SESSION_TIMEOUT_MS}ms`);
			this.ws.send(WSReqType.THINKING_END, {
				thinkingId: session.thinkingId || undefined,
				durationMs: Date.now() - session.startTime,
				status: 'error',
				error: 'thinking_session_timeout',
			});
			this.thinkingSessions.delete(sessionKey);
			this.flushPendingMessages(roomId);
		}, this.THINKING_SESSION_TIMEOUT_MS);

		this.thinkingSessions.set(sessionKey, session);

		console.log(`[thinking] start msgId=${msgId} sessionKey=${sessionKey}`);

		// 发送 THINKING_START
		this.ws.send(WSReqType.THINKING_START, {
			fromUid: this.selfUid,
			roomId,
			triggerMsgId: msgId,
		});

		const callbacks: ThinkingCallbacks = {
			onThinkingDelta: (chunk) => {
				session.seq++;
				session.accumulatedContent += chunk;
				if (!session.thinkingId) {
					session.pendingDeltas.push({ chunk, seq: session.seq });
					console.log(`[thinking] delta buffered (no thinkingId yet) session=${sessionKey} seq=${session.seq}`);
					return;
				}
				this.ws.send(WSReqType.THINKING_DELTA, {
					thinkingId: session.thinkingId,
					chunk,
					seq: session.seq,
				});
				console.log(`[thinking] delta session=${sessionKey} seq=${session.seq} chunkLen=${chunk.length}`);
			},
			// REQ-004 S3: 终结动作账本——send-wins + skip 记录原因
			onTerminalTool: (info) => {
				if (info.action === 'sent') {
					if (session.terminalAction === 'skipped') {
						console.log(`[thinking] terminal override: prior 'skipped' replaced by 'sent' (send-wins) session=${sessionKey}`);
					}
					session.terminalAction = 'sent';
					session.skipReason = undefined;
				} else {
					// skip：仅当尚未 sent 时才生效（send-wins）
					if (session.terminalAction === 'sent') {
						console.log(`[thinking] ignoring 'skipped' after 'sent' (send-wins) session=${sessionKey}`);
						return;
					}
					session.terminalAction = 'skipped';
					session.skipReason = info.reason;
				}
			},
			onThinkingEnd: (durationMs) => {
				if (session.finalized) return;
				session.finalized = true;
				if (session.timeoutId) clearTimeout(session.timeoutId);
				// CR-S6: if thinkingId backfilled but pendingDeltas not flushed yet, flush first
				if (session.thinkingId && session.pendingDeltas.length > 0) {
					console.log(`[thinking] flushing ${session.pendingDeltas.length} buffered deltas before end`);
					for (const { chunk, seq } of session.pendingDeltas) {
						this.ws.send(WSReqType.THINKING_DELTA, {
							thinkingId: session.thinkingId,
							chunk,
							seq,
						});
					}
					session.pendingDeltas = [];
				}
				// REQ-004 S3: 计算本轮有效终结结果。
				// 'none' = agent 未调用任何终结动作工具 → auto-skip 兜底。
				let skipReason: string | undefined;
				if (session.terminalAction === 'sent') {
					skipReason = undefined;
				} else if (session.terminalAction === 'skipped') {
					skipReason = session.skipReason;
				} else {
					skipReason = 'agent_no_terminal_tool';
					console.log(`[thinking] no terminal tool observed, auto-skip session=${sessionKey} reason=${skipReason}`);
				}
				this.ws.send(WSReqType.THINKING_END, {
					thinkingId: session.thinkingId || undefined,
					durationMs,
					status: 'complete',
					// 仅当本轮为 skip（显式或兜底）时附加 skipReason，sent 不带（保持账本可区分）
					...(skipReason !== undefined ? { skipReason } : {}),
				});
				console.log(`[thinking] end session=${sessionKey} durationMs=${durationMs} terminal=${session.terminalAction}${skipReason ? ` skipReason=${skipReason}` : ''}`);
				this.thinkingSessions.delete(sessionKey);
				this.flushPendingMessages(roomId);
			},
			onError: (error) => {
				if (session.finalized) return;
				session.finalized = true;
				if (session.timeoutId) clearTimeout(session.timeoutId);
				if (session.pendingDeltas.length > 0) {
					console.log(`[thinking] discarding ${session.pendingDeltas.length} buffered deltas (error)`);
					session.pendingDeltas = [];
				}
				console.error(`[thinking] error session=${sessionKey} reason=${error.message}`);
				this.ws.send(WSReqType.THINKING_END, {
					thinkingId: session.thinkingId || undefined,
					durationMs: Date.now() - session.startTime,
					status: 'error',
					error: error.message,
				});
				this.thinkingSessions.delete(sessionKey);
				this.flushPendingMessages(roomId);
			},
		};

		await this.adapter.chat(message, sessionKey, callbacks, { roomId });
	}

	/** P-M2-2: 接收 server 的 thinkingStart 广播，回填 thinkingId */
	private handleThinkingStartBroadcast(data: ThinkingStartDTO): void {
		const { fromUid, roomId, triggerMsgId } = data;

		// 只处理自己发起的 thinking（server 广播给全员，通过 fromUid 过滤）
		if (String(fromUid) !== String(this.selfUid)) return;

		const sessionKey = `aiclaw-${this.selfUid}-room-${Number(roomId)}`;
		const session = this.thinkingSessions.get(sessionKey);
		if (!session) {
			console.warn(`[thinking] received thinkingStart broadcast but no active session for ${sessionKey}`);
			return;
		}

		// 校验 triggerMsgId 匹配
		if (session.triggerMsgId !== triggerMsgId) {
			console.warn(`[thinking] triggerMsgId mismatch: session=${session.triggerMsgId}, broadcast=${triggerMsgId}`);
			return;
		}

		// 回填 thinkingId
		session.thinkingId = data.thinkingId || '';
		console.log(`[thinking] thinkingId backfilled: ${session.thinkingId} for ${sessionKey}`);

		// 刷新缓存的 deltas
		if (session.pendingDeltas.length > 0) {
			console.log(`[thinking] flushing ${session.pendingDeltas.length} buffered deltas`);
			for (const { chunk, seq } of session.pendingDeltas) {
				this.ws.send(WSReqType.THINKING_DELTA, {
					thinkingId: session.thinkingId,
					chunk,
					seq,
				});
			}
			session.pendingDeltas = [];
		}
	}

	/** M3: 群配置变更通知处理 */
	private handleGroupConfigChange(data: GroupConfigChangeDTO): void {
		if (data.aiclawUid !== this.selfUid) return;
		this.groupConfigCache.set(this.selfUid, data.roomId, data.config);
		console.log(`[config] update roomId=${data.roomId} rateLimit=${data.config.rateLimitPerMinute} respondToAi=${data.config.respondToAi}`);
	}

	/** M3: 接收 server 的 thinkingEnd 广播，处理 error 状态触发 autoReply */
	private handleThinkingEndBroadcast(data: ThinkingEndDTO): void {
		const { thinkingId, roomId, status, error } = data;

		// 无 thinkingId 的是 THINKING_START 直接拒绝
		if (!thinkingId) {
			// 【M4 降级】server 限流拒绝时可能无 thinkingId，用 roomId 匹配 session
			if (status === 'error' && (error === 'rate_limit_exceeded' || error === 'daily_limit_exceeded')) {
				if (String(data.fromUid) === String(this.selfUid)) {
					const sessionKey = `aiclaw-${this.selfUid}-room-${Number(roomId)}`;
					const session = this.thinkingSessions.get(sessionKey);
					if (session) {
						if (session.timeoutId) clearTimeout(session.timeoutId);
						const reason = error === 'rate_limit_exceeded'
							? '发言频率限制，已自动跳过本次响应'
							: '今日发言上限已达，已自动跳过本次响应';
						console.log(`[thinking] server rejected: ${error} (no thinkingId fallback), sending autoReply roomId=${roomId}`);
						this.sendAutoReply(Number(roomId), reason);
						this.thinkingSessions.delete(sessionKey);
						this.flushPendingMessages(Number(roomId));
					}
				}
			}
			return;
		}

		// 查找 active session（可能已被 onThinkingEnd/onError 清理）
		let session: ThinkingSession | undefined;
		for (const s of this.thinkingSessions.values()) {
			if (s.thinkingId === thinkingId) {
				session = s;
				break;
			}
		}

		if (session?.timeoutId) {
			clearTimeout(session.timeoutId);
		}
		if (session?.finalized) {
			this.thinkingSessions.delete(session.sessionKey);
			this.flushPendingMessages(Number(roomId));
			return;
		}

		if (status === 'error' && error) {
			switch (error) {
				case 'rate_limit_exceeded':
					console.log(`[thinking] server rejected: rate_limit_exceeded, sending autoReply roomId=${roomId}`);
					this.sendAutoReply(Number(roomId), '发言频率限制，已自动跳过本次响应');
					break;
				case 'daily_limit_exceeded':
					console.log(`[thinking] server rejected: daily_limit_exceeded, sending autoReply roomId=${roomId}`);
					this.sendAutoReply(Number(roomId), '今日发言上限已达，已自动跳过本次响应');
					break;
				default:
					console.log(`[thinking] server error: ${error} (no autoReply)`);
			}
		}

		if (session) {
			session.finalized = true;
			this.thinkingSessions.delete(session.sessionKey);
			this.flushPendingMessages(Number(roomId));
		}
	}

	/** M3: 发送 autoReply（限流/退避触发时调用） */
	private sendAutoReply(roomId: number, reason: string): void {
		if (!this.apiClient) {
			console.warn('[anti-loop] autoReply skipped: no internal API client available');
			return;
		}
		this.apiClient
			.sendMessage(roomId, `发言受限：${reason}`, { autoReply: true })
			.then((result) => {
				console.log(`[anti-loop] autoReply sent: msgId=${result.msgId} roomId=${roomId}`);
			})
			.catch((err) => {
				console.error('[anti-loop] autoReply failed:', err instanceof Error ? err.message : String(err));
			});
	}

	/** CR-S7: 清理所有 active session（进程退出时调用） */
	destroy(): void {
		for (const session of this.thinkingSessions.values()) {
			if (session.timeoutId) clearTimeout(session.timeoutId);
			if (!session.finalized) {
				session.finalized = true;
				this.ws.send(WSReqType.THINKING_END, {
					thinkingId: session.thinkingId || undefined,
					durationMs: Date.now() - session.startTime,
					status: 'error',
					error: 'handler_destroyed',
				});
			}
		}
		this.thinkingSessions.clear();
		// 清理所有房间的待处理队列与定时器；用 cancel 而非 flush，
		// 避免 teardown 时 flush 重新触发 triggerAgentLoop 复活会话。
		for (const channel of this.roomChannels.values()) {
			channel.debouncer.cancel();
			channel.pendingMessages = [];
		}
		this.roomChannels.clear();
	}

	/** REQ-004 S2: 仅刷新指定房间的待处理消息，不影响其他房间 */
	private flushPendingMessages(roomId: number): void {
		const channel = this.roomChannels.get(roomId);
		if (!channel || channel.pendingMessages.length === 0) {
			this.maybeEvictRoom(roomId);
			return;
		}
		console.log(`[handler] Flushing ${channel.pendingMessages.length} pending messages for room ${roomId}`);
		const pending = channel.pendingMessages;
		channel.pendingMessages = [];
		for (const msg of pending) {
			channel.debouncer.push(msg);
		}
	}

	/**
	 * REQ-004 S2: 回收空闲房间通道，防止长生命周期进程下 roomChannels 无界增长。
	 * 仅当无待处理消息、无缓冲 debounce、无活跃 thinking 会话时回收；
	 * 下一条消息会按需重建通道（lastCtx 每次收信都会重设）。
	 */
	private maybeEvictRoom(roomId: number): void {
		const channel = this.roomChannels.get(roomId);
		if (!channel) return;
		const sessionKey = `aiclaw-${this.selfUid}-room-${roomId}`;
		if (
			channel.pendingMessages.length === 0 &&
			channel.debouncer.pending === 0 &&
			!this.thinkingSessions.has(sessionKey)
		) {
			this.roomChannels.delete(roomId);
		}
	}
}
