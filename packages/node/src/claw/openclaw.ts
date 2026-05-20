import WebSocket from 'ws';
import { randomUUID, createPrivateKey, sign, createPublicKey } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { ClawAdapter, StreamCallbacks } from './interface.js';

/**
 * Device identity for gateway authentication
 */
interface DeviceIdentity {
	deviceId: string;
	publicKeyPem: string;
	privateKeyPem: string;
}

function loadDeviceIdentity(): DeviceIdentity | null {
	const path = resolve(homedir(), '.openclaw', 'identity', 'device.json');
	if (!existsSync(path)) return null;
	try {
		const raw = readFileSync(path, 'utf-8');
		const parsed = JSON.parse(raw);
		if (parsed.deviceId && parsed.publicKeyPem && parsed.privateKeyPem) {
			return parsed as DeviceIdentity;
		}
		return null;
	} catch {
		return null;
	}
}

function signPayload(privateKeyPem: string, payload: string): string {
	const key = createPrivateKey(privateKeyPem);
	const sig = sign(null, Buffer.from(payload, 'utf8'), key);
	return sig.toString('base64url');
}

function publicKeyRawBase64Url(publicKeyPem: string): string {
	const key = createPublicKey(publicKeyPem);
	const der = key.export({ type: 'spki', format: 'der' });
	// Ed25519 SPKI DER: 12-byte header + 32-byte raw key
	const raw = der.subarray(der.length - 32);
	return raw.toString('base64url');
}

/**
 * Gateway 帧类型定义（精简版，基于 openclaw gateway protocol schema）
 */

interface RequestFrame {
	type: 'req';
	id: string;
	method: string;
	params?: unknown;
}

interface ResponseFrame {
	type: 'res';
	id: string;
	ok: boolean;
	payload?: Record<string, unknown>;
	error?: { code: string; message: string; details?: unknown };
}

interface EventFrame {
	type: 'event';
	event: string;
	payload?: Record<string, unknown>;
	seq?: number;
}

interface AgentEvent {
	runId: string;
	seq: number;
	stream: string;
	ts: number;
	data: Record<string, unknown>;
}

type GatewayFrame = RequestFrame | ResponseFrame | EventFrame;

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
	expectFinal: boolean;
	timeout: ReturnType<typeof setTimeout> | null;
}

interface PendingChat {
	callbacks: StreamCallbacks;
	fullContent: string;
	done: boolean;
	startTime: number; // REQ-004: 用于计算 thinking durationMs
}

/**
 * openclaw WS RPC 适配器
 * 通过 WebSocket 连接 openclaw gateway，走完整 agent pipeline
 */
export class OpenclawAdapter implements ClawAdapter {
	readonly type = 'openclaw';

	private ws: WebSocket | null = null;
	private url: string;
	private token: string;
	private closed = false;
	private connected = false;
	private reconnectDelay = 1000;
	private maxReconnectDelay = 30000;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private tickTimer: ReturnType<typeof setInterval> | null = null;
	private lastTick: number | null = null;
	private tickIntervalMs = 30000;

	/** connect challenge nonce */
	private connectNonce: string | null = null;
	private connectSent = false;
	private connectTimer: ReturnType<typeof setTimeout> | null = null;

	/** Pending RPC requests */
	private pending = new Map<string, PendingRequest>();

	/** Active chat streams by runId */
	private activeChats = new Map<string, PendingChat>();

	/** Map requestId → runId for linking response to chat */
	private requestToRunId = new Map<string, string>();

	/** Resolve function for initial connect() promise */
	private connectResolve: (() => void) | null = null;
	private connectReject: ((err: Error) => void) | null = null;

	constructor(url = 'ws://localhost:18789', token = '') {
		this.url = url;
		this.token = token;
	}

	async connect(): Promise<void> {
		if (this.connected) return;
		this.closed = false;

		return new Promise<void>((resolve, reject) => {
			this.connectResolve = resolve;
			this.connectReject = reject;
			this.startWs();
		});
	}

	async disconnect(): Promise<void> {
		this.closed = true;
		this.connected = false;
		this.clearTimers();
		this.flushPendingErrors(new Error('adapter disconnected'));
		this.ws?.close();
		this.ws = null;
	}

	async chat(message: string, sessionKey: string, callbacks: StreamCallbacks): Promise<void> {
		if (!this.connected || !this.ws) {
			callbacks.onError(new Error('openclaw gateway not connected'));
			return;
		}

		const requestId = randomUUID();
		const idempotencyKey = randomUUID();

		const params = {
			message,
			sessionKey,
			idempotencyKey,
		};

		const frame: RequestFrame = {
			type: 'req',
			id: requestId,
			method: 'agent',
			params,
		};

		// 注册 pending request，expectFinal=true（先 accepted 再最终 response）
		this.pending.set(requestId, {
			resolve: () => {},  // response frame 不驱动完成，由 lifecycle event 驱动
			reject: (err) => {
				// 只在连接断开等异常时触发
				const chat = this.findChatByRequestId(requestId);
				if (chat && !chat.done) {
					chat.done = true;
					callbacks.onError(err instanceof Error ? err : new Error(String(err)));
					this.cleanupChat(requestId);
				}
			},
			expectFinal: true,
			timeout: null,
		});

		// 预注册 chat state
		this.requestToRunId.set(requestId, '');
		this.activeChats.set(`req:${requestId}`, {
			callbacks,
			fullContent: '',
			done: false,
			startTime: Date.now(),
		});

		this.ws.send(JSON.stringify(frame));
	}

	get isConnected(): boolean {
		return this.connected;
	}

	// ─── WebSocket lifecycle ───

	private startWs(): void {
		if (this.closed) return;

		const ws = new WebSocket(this.url, {
			maxPayload: 25 * 1024 * 1024,
		});
		this.ws = ws;

		ws.on('open', () => {
			console.log('[openclaw] WebSocket opened, waiting for connect challenge...');
			this.connectNonce = null;
			this.connectSent = false;
			// 设置 challenge 超时
			this.connectTimer = setTimeout(() => {
				if (!this.connectSent) {
					console.error('[openclaw] Connect challenge timeout');
					ws.close(1008, 'connect challenge timeout');
				}
			}, 5000);
		});

		ws.on('message', (data) => {
			this.handleMessage(data.toString());
		});

		ws.on('close', (code, reason) => {
			const reasonText = reason.toString();
			console.log(`[openclaw] Disconnected: code=${code}, reason=${reasonText}`);
			this.connected = false;
			this.clearTimers();
			this.flushPendingErrors(new Error(`gateway closed (${code}): ${reasonText}`));

			if (!this.closed) {
				this.scheduleReconnect();
			}
		});

		ws.on('error', (err) => {
			console.error('[openclaw] WebSocket error:', err.message);
			if (!this.connectSent && this.connectReject) {
				this.connectReject(err instanceof Error ? err : new Error(String(err)));
				this.connectReject = null;
				this.connectResolve = null;
			}
		});
	}

	private handleMessage(raw: string): void {
		let parsed: GatewayFrame;
		try {
			parsed = JSON.parse(raw);
		} catch {
			console.warn('[openclaw] Failed to parse message');
			return;
		}

		if (parsed.type === 'event') {
			this.handleEvent(parsed as EventFrame);
		} else if (parsed.type === 'res') {
			this.handleResponse(parsed as ResponseFrame);
		}
	}

	private handleEvent(evt: EventFrame): void {
		// connect.challenge → 发送 connect params
		if (evt.event === 'connect.challenge') {
			const payload = evt.payload as { nonce?: string } | undefined;
			const nonce = payload?.nonce;
			if (!nonce?.trim()) {
				console.error('[openclaw] Connect challenge missing nonce');
				this.ws?.close(1008, 'missing nonce');
				return;
			}
			this.connectNonce = nonce.trim();
			this.sendConnect();
			return;
		}

		// tick → 更新心跳时间
		if (evt.event === 'tick') {
			this.lastTick = Date.now();
			return;
		}

		// agent 事件 → 流式回复
		if (evt.event === 'agent') {
			const agentEvt = evt.payload as unknown as AgentEvent;
			if (agentEvt?.runId) {
				this.handleAgentEvent(agentEvt);
			}
			return;
		}

		// shutdown 事件
		if (evt.event === 'shutdown') {
			console.warn('[openclaw] Gateway shutting down:', (evt.payload as { reason?: string })?.reason);
			return;
		}
	}

	private handleResponse(res: ResponseFrame): void {
		const pending = this.pending.get(res.id);
		if (!pending) return;

		const payload = res.payload;
		const status = payload?.status as string | undefined;

		// accepted → agent 请求已接受，继续等待最终 response
		if (pending.expectFinal && status === 'accepted') {
			// 关联 runId
			const runId = payload?.runId as string | undefined;
			if (runId) {
				this.linkRunIdToRequest(res.id, runId);
			}
			return;
		}

		// 最终 response
		this.pending.delete(res.id);
		if (pending.timeout) {
			clearTimeout(pending.timeout);
		}

		if (res.ok) {
			pending.resolve(payload);
		} else {
			const errMsg = res.error?.message || 'unknown gateway error';
			pending.reject(new Error(`[${res.error?.code || 'UNKNOWN'}] ${errMsg}`));
		}
	}

	private handleAgentEvent(evt: AgentEvent): void {
		const chat = this.activeChats.get(`run:${evt.runId}`);
		if (!chat) {
			// 可能 runId 还没关联，尝试通过 requestId 查找并关联
			for (const [reqId, runId] of this.requestToRunId) {
				if (runId === '' || runId === evt.runId) {
					this.requestToRunId.set(reqId, evt.runId);
					const pendingChat = this.activeChats.get(`req:${reqId}`);
					if (pendingChat) {
						this.activeChats.set(`run:${evt.runId}`, pendingChat);
						this.activeChats.delete(`req:${reqId}`);
						this.processAgentStreamEvent(pendingChat, evt);
					}
					return;
				}
			}
			return;
		}

		this.processAgentStreamEvent(chat, evt);
	}

	private processAgentStreamEvent(chat: PendingChat, evt: AgentEvent): void {
		// assistant 流 → 提取 delta chunk
		if (evt.stream === 'assistant') {
			const delta = evt.data.delta as string | undefined;
			if (delta) {
				chat.fullContent += delta;
				chat.callbacks.onChunk(delta);
			}
		}
		// lifecycle 流 → 检查完成状态
		if (evt.stream === 'lifecycle' && !chat.done) {
			const phase = evt.data.phase as string | undefined;
			if (phase === 'end') {
				chat.done = true;
				chat.callbacks.onDone(chat.fullContent);
				this.cleanupChatByRunId(evt.runId);
			} else if (phase === 'error') {
				chat.done = true;
				chat.callbacks.onError(new Error(evt.data.error as string || 'agent run failed'));
				this.cleanupChatByRunId(evt.runId);
			}
		}
	}

	// ─── Connect handshake ───

	private sendConnect(): void {
		if (this.connectSent || !this.ws || !this.connectNonce) return;
		this.connectSent = true;

		if (this.connectTimer) {
			clearTimeout(this.connectTimer);
			this.connectTimer = null;
		}

		const role = 'operator';
		const scopes = [
			'operator.admin',
			'operator.read',
			'operator.write',
			'operator.approvals',
			'operator.pairing',
		];
		const platform = process.platform;
		const signedAtMs = Date.now();
		const nonce = this.connectNonce!;

		// Build device identity signature
		const deviceIdentity = loadDeviceIdentity();
		let device: Record<string, unknown> | undefined;
		let signatureToken: string | undefined;

		if (deviceIdentity) {
			signatureToken = this.token || undefined;
			// Build v3 payload: "v3|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce|platform|deviceFamily"
			const payloadParts = [
				'v3',
				deviceIdentity.deviceId,
				'gateway-client',
				'backend',
				role,
				scopes.join(','),
				String(signedAtMs),
				signatureToken ?? '',
				nonce,
				platform,
				'', // deviceFamily
			];
			const payload = payloadParts.join('|');
			const signature = signPayload(deviceIdentity.privateKeyPem, payload);

			device = {
				id: deviceIdentity.deviceId,
				publicKey: publicKeyRawBase64Url(deviceIdentity.publicKeyPem),
				signature,
				signedAt: signedAtMs,
				nonce,
			};
			console.log(`[openclaw] Using device identity: ${deviceIdentity.deviceId.substring(0, 8)}...`);
		}

		const params: Record<string, unknown> = {
			minProtocol: 3,
			maxProtocol: 3,
			client: {
				id: 'gateway-client',
				displayName: 'aichat-node',
				version: '0.1.0',
				platform,
				mode: 'backend',
			},
			auth: this.token ? { token: this.token } : undefined,
			role,
			scopes,
			device,
		};

		const requestId = randomUUID();
		const frame: RequestFrame = {
			type: 'req',
			id: requestId,
			method: 'connect',
			params,
		};

		this.ws.send(JSON.stringify(frame));

		// 等待 hello-ok response
		const connectPromise = new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(requestId);
				reject(new Error('connect handshake timeout'));
			}, 10000);

			this.pending.set(requestId, {
				resolve: (payload) => {
					clearTimeout(timeout);
					const helloOk = payload as Record<string, unknown>;
					if (helloOk?.type === 'hello-ok') {
						console.log(`[openclaw] Connected to gateway v${(helloOk.server as Record<string, unknown>)?.version || 'unknown'}`);
						const policy = helloOk.policy as Record<string, unknown> | undefined;
						if (typeof policy?.tickIntervalMs === 'number') {
							this.tickIntervalMs = policy.tickIntervalMs;
						}
					}
					this.connected = true;
					this.reconnectDelay = 1000;
					this.lastTick = Date.now();
					this.startTickWatch();
					resolve();
				},
				reject: (err) => {
					clearTimeout(timeout);
					reject(err);
				},
				expectFinal: false,
				timeout: null,
			});
		});

		connectPromise
			.then(() => {
				if (this.connectResolve) {
					this.connectResolve();
					this.connectResolve = null;
					this.connectReject = null;
				}
			})
			.catch((err) => {
				console.error('[openclaw] Connect handshake failed:', err.message);
				if (this.connectReject) {
					this.connectReject(err instanceof Error ? err : new Error(String(err)));
					this.connectReject = null;
					this.connectResolve = null;
				}
				this.ws?.close(1008, 'connect failed');
			});
	}

	// ─── Chat state management ───

	private linkRunIdToRequest(requestId: string, runId: string): void {
		this.requestToRunId.set(requestId, runId);
		const chat = this.activeChats.get(`req:${requestId}`);
		if (chat) {
			this.activeChats.set(`run:${runId}`, chat);
			this.activeChats.delete(`req:${requestId}`);
		}
	}

	private findChatByRequestId(requestId: string): PendingChat | undefined {
		// 先查 req: key
		const byReq = this.activeChats.get(`req:${requestId}`);
		if (byReq) return byReq;
		// 再查关联的 runId
		const runId = this.requestToRunId.get(requestId);
		if (runId) {
			return this.activeChats.get(`run:${runId}`);
		}
		return undefined;
	}

	private cleanupChat(requestId: string): void {
		this.activeChats.delete(`req:${requestId}`);
		const runId = this.requestToRunId.get(requestId);
		if (runId) {
			this.activeChats.delete(`run:${runId}`);
		}
		this.requestToRunId.delete(requestId);
		this.pending.delete(requestId);
	}

	private cleanupChatByRunId(runId: string): void {
		this.activeChats.delete(`run:${runId}`);
		for (const [reqId, rId] of this.requestToRunId) {
			if (rId === runId) {
				this.activeChats.delete(`req:${reqId}`);
				this.requestToRunId.delete(reqId);
				this.pending.delete(reqId);
				break;
			}
		}
	}

	// ─── Reconnect & heartbeat ───

	private scheduleReconnect(): void {
		if (this.closed) return;
		console.log(`[openclaw] Reconnecting in ${this.reconnectDelay}ms...`);
		this.reconnectTimer = setTimeout(() => {
			this.startWs();
		}, this.reconnectDelay);
		this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
	}

	private startTickWatch(): void {
		if (this.tickTimer) {
			clearInterval(this.tickTimer);
		}
		this.tickTimer = setInterval(() => {
			if (this.closed || !this.lastTick) return;
			const gap = Date.now() - this.lastTick;
			if (gap > this.tickIntervalMs * 2) {
				console.warn('[openclaw] Tick timeout, closing connection');
				this.ws?.close(4000, 'tick timeout');
			}
		}, Math.max(this.tickIntervalMs, 1000));
	}

	private clearTimers(): void {
		if (this.tickTimer) {
			clearInterval(this.tickTimer);
			this.tickTimer = null;
		}
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (this.connectTimer) {
			clearTimeout(this.connectTimer);
			this.connectTimer = null;
		}
	}

	private flushPendingErrors(err: Error): void {
		for (const [, p] of this.pending) {
			if (p.timeout) clearTimeout(p.timeout);
			p.reject(err);
		}
		this.pending.clear();

		// Fail all active chats
		for (const [, chat] of this.activeChats) {
			if (!chat.done) {
				chat.done = true;
				chat.callbacks.onError(err);
			}
		}
		this.activeChats.clear();
		this.requestToRunId.clear();
	}
}
