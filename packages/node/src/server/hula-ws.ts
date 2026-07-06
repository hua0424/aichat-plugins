import WebSocket from 'ws';
import { WSReqType, type WSResponse, buildRequest } from '../stream/protocol.js';

export interface HulaWSClientOptions {
	url: string;
	token: string;
	clientId: string; // machineCode
	onMessage: (msg: WSResponse) => void;
	onConnected?: () => void;
	onDisconnected?: () => void;
	/** 认证失败时回调（如 token 过期 401/406），返回 true 表示已刷新可重连 */
	onAuthError?: () => Promise<boolean>;
	/**
	 * #152 半开检测看门狗：每隔多久发一次 ws ping 帧并检查存活（默认 30s）。
	 * 与应用层 25s HEARTBEAT 是两回事——后者防服务端踢，本 ping 只探本端 socket 是否半开。
	 */
	pingIntervalMs?: number;
	/** #152 距上次收到任意入站帧超过此阈值即判定半开、强制 terminate 触发重连（默认 60s）。 */
	deadAfterMs?: number;
}

/**
 * HuLa-Server WebSocket 客户端
 * 自动重连（指数退避）+ 心跳保活
 */
export class HulaWSClient {
	private ws: WebSocket | null = null;
	private options: HulaWSClientOptions;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private watchdogTimer: ReturnType<typeof setInterval> | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectDelay = 1000;
	private maxReconnectDelay = 30000;
	private closed = false;
	/** #152 上次收到任意入站帧（open/pong/message）的时刻；看门狗据此判定半开。 */
	private lastAliveAt = 0;
	private readonly pingIntervalMs: number;
	private readonly deadAfterMs: number;

	constructor(options: HulaWSClientOptions) {
		this.options = options;
		this.pingIntervalMs = options.pingIntervalMs ?? 30000;
		this.deadAfterMs = options.deadAfterMs ?? 60000;
	}

	connect(): void {
		this.closed = false;
		console.log(`[hula-ws] Connecting to ${this.options.url}...`);

		// CR-M1: token 走 header，clientId 走 sub-protocol，不再暴露在 URL query 中
		this.ws = new WebSocket(
			this.options.url,
			['aiclaw-v1', `clientId_${this.options.clientId}`],
			{ headers: { 'Token': this.options.token } }
		);

		this.ws.on('open', () => {
			console.log('[hula-ws] Connected');
			this.reconnectDelay = 1000;
			this.lastAliveAt = Date.now();
			this.startHeartbeat();
			this.startWatchdog();
			this.options.onConnected?.();
		});

		// #152 ws 协议层 pong（对我们主动 ping 的回应）证明本端 socket 仍活
		this.ws.on('pong', () => {
			this.lastAliveAt = Date.now();
		});

		this.ws.on('message', (data) => {
			// #152 任意入站帧都证明连接存活，避免慢速但正常的流量被误杀
			this.lastAliveAt = Date.now();
			try {
				const msg = JSON.parse(data.toString()) as WSResponse;
				this.options.onMessage(msg);
			} catch (err) {
				console.error('[hula-ws] Failed to parse message:', err);
			}
		});

		this.ws.on('close', (code, reason) => {
			console.log(`[hula-ws] Disconnected: code=${code}, reason=${reason.toString()}`);
			this.stopHeartbeat();
			this.stopWatchdog();
			this.options.onDisconnected?.();
			if (!this.closed) {
				this.scheduleReconnect();
			}
		});

		this.ws.on('error', async (err) => {
			console.error('[hula-ws] Error:', err.message);
			// 检测 WS 握手失败（非 101 响应，通常是认证问题）
			if (err.message.includes('Unexpected server response')) {
				const statusCode = err.message.match(/(\d{3})/)?.[1];
				if (statusCode && statusCode !== '101') {
					console.warn(`[hula-ws] Auth/connection failed with HTTP ${statusCode}, stopping reconnect`);
					this.closed = true;
					this.stopHeartbeat();
					this.stopWatchdog();
					if (this.reconnectTimer) {
						clearTimeout(this.reconnectTimer);
						this.reconnectTimer = null;
					}
					if (this.options.onAuthError) {
						try {
							const canRetry = await this.options.onAuthError();
							if (canRetry) {
								this.closed = false;
								this.scheduleReconnect();
							}
						} catch (e) {
							console.error('[hula-ws] onAuthError failed:', e);
						}
					}
				}
			}
		});
	}

	send(type: WSReqType, data: Record<string, unknown>): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(buildRequest(type, data));
		} else {
			console.warn('[hula-ws] Not connected, dropping message');
		}
	}

	close(): void {
		this.closed = true;
		this.stopHeartbeat();
		this.stopWatchdog();
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
		}
		this.ws?.close();
	}

	get isConnected(): boolean {
		return this.ws?.readyState === WebSocket.OPEN;
	}

	private startHeartbeat(): void {
		this.heartbeatTimer = setInterval(() => {
			this.send(WSReqType.HEARTBEAT, {});
		}, 25000); // server timeout is 30s
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}

	/**
	 * #152 半开检测看门狗（与应用层心跳并存、职责不同）。
	 * 每 pingIntervalMs：若距上次入站帧已 >= deadAfterMs，判定 TCP 半开（连着但零流量），
	 * 直接 terminate 摧毁 socket（不用 close——半开的对端不会 ACK 关闭帧），
	 * 由此触发既有 'close' → scheduleReconnect 自愈链；否则主动 ping 探活。
	 */
	private startWatchdog(): void {
		this.watchdogTimer = setInterval(() => {
			if (this.ws?.readyState !== WebSocket.OPEN) return;
			const since = Date.now() - this.lastAliveAt;
			if (since >= this.deadAfterMs) {
				console.warn(
					`[hula-ws] watchdog: no inbound for ${since}ms (>= ${this.deadAfterMs}ms), half-open — terminating to force reconnect`,
				);
				this.ws.terminate();
				return;
			}
			this.ws.ping();
		}, this.pingIntervalMs);
	}

	private stopWatchdog(): void {
		if (this.watchdogTimer) {
			clearInterval(this.watchdogTimer);
			this.watchdogTimer = null;
		}
	}

	private scheduleReconnect(): void {
		console.log(`[hula-ws] Reconnecting in ${this.reconnectDelay}ms...`);
		this.reconnectTimer = setTimeout(() => {
			this.connect();
		}, this.reconnectDelay);
		this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
	}
}
