import type { WSResponse, ReceivedMessage, ThinkingStartDTO, ThinkingEndDTO, GroupConfigChangeDTO } from '../stream/protocol.js';
import type { HulaWSClient } from '../server/hula-ws.js';
import { WSReqType } from '../stream/protocol.js';
import type { ClawAdapter, ThinkingCallbacks } from '../claw/interface.js';
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
 * 消息处理器（REQ-004 Agent Loop 模型）
 * 接收用户消息 → ACK → 去重 → 触发 agent loop → THINKING 流式输出
 */
export class MessageHandler {
	private ws: HulaWSClient;
	private adapter: ClawAdapter;
	private selfUid: number;
	private debouncer: MessageDebouncer;

	// REQ-004: 替换 streaming boolean 为 thinkingSessions Map
	private thinkingSessions = new Map<string, ThinkingSession>();
	private pendingMessages: string[] = [];
	private lastCtx: LastMessageContext | null = null;

	/** 已处理的 msgId 集合（防重复推送） */
	private processedMsgIds = new Set<string>();

	/** thinking session 超时时间（5 分钟） */
	private readonly THINKING_SESSION_TIMEOUT_MS = 5 * 60 * 1000;

	// REQ-004 M3: 防循环守卫 + 群配置缓存
	private antiLoopGuard: AntiLoopGuard;
	private groupConfigCache: GroupConfigCache;

	// REQ-004 M3: 内嵌 HulaApiClient（仅用于 autoReply / CLI）
	private apiClient: HulaApiClient | null = null;

	constructor(ws: HulaWSClient, adapter: ClawAdapter, selfUid: number, apiClient?: HulaApiClient) {
		this.ws = ws;
		this.adapter = adapter;
		this.selfUid = selfUid;
		this.antiLoopGuard = new AntiLoopGuard();
		this.groupConfigCache = new GroupConfigCache();
		this.apiClient = apiClient || null;
		this.debouncer = new MessageDebouncer((merged) => {
			this.triggerAgentLoop(merged).catch((err) => {
				console.error('[handler] triggerAgentLoop unhandled error:', err.message);
			});
		});
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
		const extra = data.message.body?.urlContentMap as Record<string, unknown> | undefined;
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

		// 缓存消息上下文
		this.lastCtx = { roomId, fromUid, msgId };

		console.log(`[handler] Message from ${data.fromUser.name ?? 'unknown'}(${data.fromUser.uid}) in room ${roomId}: ${content.substring(0, 50)}...`);

		const sessionKey = `aiclaw-${this.selfUid}-room-${roomId}`;

		// 6. 检查 thinking session 是否已存在
		if (this.thinkingSessions.has(sessionKey)) {
			this.pendingMessages.push(content);
			console.log(`[handler] Message queued (thinking active), pending: ${this.pendingMessages.length}`);
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
				this.debouncer.push(content);
			}, guardResult.delayMs);
			return;
		}

		// 正常触发
		this.debouncer.push(content);
	}

	private async triggerAgentLoop(message: string): Promise<void> {
		if (!this.ws.isConnected) {
			console.warn('[handler] WS not connected, dropping AI request');
			return;
		}

		if (!this.lastCtx) {
			console.warn('[handler] No message context, dropping AI request');
			return;
		}

		const { roomId, msgId } = this.lastCtx;
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
		};

		// 设置 5 分钟超时定时器（P-M2-3）
		session.timeoutId = setTimeout(() => {
			console.error(`[thinking] timeout session=${sessionKey} after ${this.THINKING_SESSION_TIMEOUT_MS}ms`);
			this.ws.send(WSReqType.THINKING_END, {
				thinkingId: session.thinkingId || undefined,
				durationMs: Date.now() - session.startTime,
				status: 'error',
				error: 'thinking_session_timeout',
			});
			this.thinkingSessions.delete(sessionKey);
			this.flushPendingMessages();
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
				this.ws.send(WSReqType.THINKING_DELTA, {
					thinkingId: session.thinkingId || undefined,
					chunk,
					seq: session.seq,
				});
				console.log(`[thinking] delta session=${sessionKey} seq=${session.seq} chunkLen=${chunk.length}`);
			},
			onThinkingEnd: (durationMs) => {
				if (session.timeoutId) clearTimeout(session.timeoutId);
				this.ws.send(WSReqType.THINKING_END, {
					thinkingId: session.thinkingId || undefined,
					durationMs,
					status: 'complete',
				});
				console.log(`[thinking] end session=${sessionKey} durationMs=${durationMs}`);
				this.thinkingSessions.delete(sessionKey);
				this.flushPendingMessages();
			},
			onError: (error) => {
				if (session.timeoutId) clearTimeout(session.timeoutId);
				console.error(`[thinking] error session=${sessionKey} reason=${error.message}`);
				this.ws.send(WSReqType.THINKING_END, {
					thinkingId: session.thinkingId || undefined,
					durationMs: Date.now() - session.startTime,
					status: 'error',
					error: error.message,
				});
				this.thinkingSessions.delete(sessionKey);
				this.flushPendingMessages();
			},
		};

		await this.adapter.chat(message, sessionKey, callbacks);
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

		// 无 thinkingId 的是 THINKING_START 直接拒绝，server-dev 说不需要处理
		if (!thinkingId) return;

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
				case 'short_reply_skip':
					// 短回复跳过不触发 autoReply，避免短回复+autoReply 互相触发新循环
					console.log('[anti-loop] short reply skip triggered, no autoReply');
					break;
				default:
					console.log(`[thinking] server error: ${error} (no autoReply)`);
			}
		}

		if (session) {
			this.thinkingSessions.delete(session.sessionKey);
			this.flushPendingMessages();
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

	private flushPendingMessages(): void {
		if (this.pendingMessages.length === 0) return;
		console.log(`[handler] Flushing ${this.pendingMessages.length} pending messages`);
		for (const msg of this.pendingMessages) {
			this.debouncer.push(msg);
		}
		this.pendingMessages = [];
	}
}
