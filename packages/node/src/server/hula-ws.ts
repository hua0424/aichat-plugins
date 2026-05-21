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
}

/**
 * HuLa-Server WebSocket 客户端
 * 自动重连（指数退避）+ 心跳保活
 */
export class HulaWSClient {
	private ws: WebSocket | null = null;
	private options: HulaWSClientOptions;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectDelay = 1000;
	private maxReconnectDelay = 30000;
	private closed = false;

	constructor(options: HulaWSClientOptions) {
		this.options = options;
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
			this.startHeartbeat();
			this.options.onConnected?.();
		});

		this.ws.on('message', (data) => {
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

	private scheduleReconnect(): void {
		console.log(`[hula-ws] Reconnecting in ${this.reconnectDelay}ms...`);
		this.reconnectTimer = setTimeout(() => {
			this.connect();
		}, this.reconnectDelay);
		this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
	}
}
