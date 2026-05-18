import type { WSResponse, ReceivedMessage } from '../stream/protocol.js';
import type { HulaWSClient } from '../server/hula-ws.js';
import { WSReqType } from '../stream/protocol.js';
import type { ClawAdapter, StreamCallbacks } from '../claw/interface.js';
import { MessageDebouncer } from '../utils/debounce.js';

/**
 * 最近一次收到的用户消息上下文（用于 stream 回复时定位 roomId/toUid）
 */
interface LastMessageContext {
	roomId: number;
	fromUid: number; // 发送者 uid（即 stream 回复的目标 toUid）
	msgId: string;   // 触发 stream 的原始消息 id（用于日志关联）
}

/**
 * 消息处理器
 * 接收用户消息 → ACK → 去重 → 防抖合并 → 转发 Claw 适配器 → 流式回复
 */
export class MessageHandler {
	private ws: HulaWSClient;
	private adapter: ClawAdapter;
	private selfUid: number;
	private debouncer: MessageDebouncer;
	private streaming = false;
	private pendingMessages: string[] = [];
	private lastCtx: LastMessageContext | null = null;
	/** 已处理的 msgId 集合（防重复推送） */
	private processedMsgIds = new Set<string>();

	constructor(ws: HulaWSClient, adapter: ClawAdapter, selfUid: number) {
		this.ws = ws;
		this.adapter = adapter;
		this.selfUid = selfUid;
		this.debouncer = new MessageDebouncer((merged) => {
			this.sendToAI(merged).catch((err) => {
				console.error('[handler] sendToAI unhandled error:', err.message);
				this.streaming = false;
			});
		});
	}

	handle(msg: WSResponse): void {
		switch (msg.type) {
			case 'receiveMessage':
				this.handleReceiveMessage(msg.data as ReceivedMessage);
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

		// 1. 发送 ACK（告知 server 消息已收到，停止重试）
		this.ws.send(WSReqType.ACK, {
			msgId: Number(msgId),
			timestamp: Date.now(),
		});

		// 2. 去重（server 重试推送的同一条消息跳过）
		if (this.processedMsgIds.has(msgId)) {
			return;
		}
		this.processedMsgIds.add(msgId);
		// 限制集合大小，避免内存泄漏
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

		// 缓存消息上下文
		this.lastCtx = {
			roomId: Number(data.message.roomId),
			fromUid: Number(data.fromUser.uid),
			msgId,
		};

		console.log(`[handler] Message from ${data.fromUser.name ?? 'unknown'}(${data.fromUser.uid}) in room ${data.message.roomId}: ${content.substring(0, 50)}...`);

		if (this.streaming) {
			this.pendingMessages.push(content);
			console.log(`[handler] Message queued (streaming active), pending: ${this.pendingMessages.length}`);
		} else {
			this.debouncer.push(content);
		}
	}

	private async sendToAI(message: string): Promise<void> {
		if (!this.ws.isConnected) {
			console.warn('[handler] WS not connected, dropping AI request');
			return;
		}

		if (!this.lastCtx) {
			console.warn('[handler] No message context, dropping AI request');
			return;
		}

		const { roomId, fromUid: toUid, msgId } = this.lastCtx;
		let seq = 0;
		this.streaming = true;

		// sessionKey 格式：aiclaw-{selfUid}-room-{roomId}
		const sessionKey = `aiclaw-${this.selfUid}-room-${roomId}`;

		console.log(`[stream] start msgId=${msgId} fromUid=${this.selfUid} toUid=${toUid} roomId=${roomId} sessionKey=${sessionKey}`);

		this.ws.send(WSReqType.STREAM_START, {
			fromUid: this.selfUid,
			toUid,
			roomId,
		});

		const callbacks: StreamCallbacks = {
			onChunk: (chunk) => {
				this.ws.send(WSReqType.STREAM_DELTA, {
					chunk,
					seq: ++seq,
				});
				console.log(`[stream] delta msgId=${msgId} seq=${seq} chunkLen=${chunk.length}`);
			},
			onDone: (fullContent) => {
				this.ws.send(WSReqType.STREAM_END, {
					fullContent,
					status: 'complete',
				});
				console.log(`[stream] end msgId=${msgId} status=complete contentLen=${fullContent.length}`);
				this.streaming = false;
				this.flushPendingMessages();
			},
			onError: (error) => {
				console.error(`[stream] error msgId=${msgId} status=error reason=${error.message}`);
				this.ws.send(WSReqType.STREAM_END, {
					fullContent: '抱歉，我的大脑目前宕机了，请主人关心一下我的身体情况',
					status: 'error',
				});
				this.streaming = false;
				this.flushPendingMessages();
			},
		};

		await this.adapter.chat(message, sessionKey, callbacks);
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
