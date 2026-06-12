import WebSocket from 'ws';
import { randomUUID, createPrivateKey, sign, createPublicKey } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { ClawAdapter, ChatContext, ThinkingCallbacks } from './interface.js';

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
 * Pure builder for the `connect` req params (protocol v4).
 *
 * Extracted from sendConnect so the protocol negotiation + client block can be
 * unit-tested without a live socket. The device identity / signature is built
 * by the caller and passed in via `device`.
 */
export function buildConnectParams(opts: {
	token?: string;
	device: Record<string, unknown> | undefined;
	role: string;
	scopes: string[];
	platform: string;
}): Record<string, unknown> {
	const { token, device, role, scopes, platform } = opts;
	return {
		minProtocol: 4,
		maxProtocol: 4,
		client: {
			id: 'gateway-client',
			displayName: 'aichat-node',
			version: '0.1.0',
			platform,
			mode: 'backend',
		},
		auth: token ? { token } : undefined,
		role,
		scopes,
		device,
	};
}

/**
 * Pure parser for a gateway `hello-ok` payload (protocol v4).
 *
 * v4 hello-ok adds `protocol` (integer) and `server.connId` (string); both are
 * informational/diagnostic so their absence must NOT fail the handshake. The
 * v3-compatible `server.version` and `policy.tickIntervalMs` are still read.
 */
export function parseHelloOk(payload: unknown): {
	ok: boolean;
	protocol?: number;
	connId?: string;
	version?: string;
	tickIntervalMs?: number;
} {
	if (!payload || typeof payload !== 'object') return { ok: false };
	const helloOk = payload as Record<string, unknown>;
	if (helloOk.type !== 'hello-ok') return { ok: false };

	const result: {
		ok: boolean;
		protocol?: number;
		connId?: string;
		version?: string;
		tickIntervalMs?: number;
	} = { ok: true };

	if (Number.isInteger(helloOk.protocol)) {
		result.protocol = helloOk.protocol as number;
	}

	const server = helloOk.server as Record<string, unknown> | undefined;
	if (typeof server?.version === 'string') {
		result.version = server.version;
	}
	if (typeof server?.connId === 'string' && server.connId.length > 0) {
		result.connId = server.connId;
	}

	const policy = helloOk.policy as Record<string, unknown> | undefined;
	const tick = policy?.tickIntervalMs;
	if (Number.isFinite(tick) && (tick as number) > 0) {
		result.tickIntervalMs = tick as number;
	}

	return result;
}

/**
 * REQ-004 S3: 纯函数——把一次 tool item 调用分类为终结动作（send / skip）或非终结动作（null）。
 *
 * 真实数据形态（openclaw 2026.6.5 实测）：tool 调用经 `item` 流到达，end 事件只携带
 * name + status，**没有 args**（无 channel、无 reason）。故只能按 NAME + status==='completed'
 * 分类，无法从事件读取 channel / model 自填的 skip reason。
 *
 * agent 可经两条合法路径回复 HuLa：
 *  - claw 工具 hula_send_message（→ sent）
 *  - openclaw 内置 message 工具（→ sent）
 * 跳过则走 hula_skip_reply（→ skipped，reason 固定为 'agent_skip_reply'）。
 * 其余工具名（hula_find_friend、command/patch/search 等）不是终结动作，返回 null。
 *
 * 仅 status==='completed' 才算终结动作；start / running / failed 一律 null。
 */
export function classifyTerminalTool(
	name: string | undefined,
	status: string | undefined,
): { action: 'sent' | 'skipped'; tool: string; reason?: string } | null {
	// 只统计成功完成的工具——start / running / failed 都不是终结动作
	if (status !== 'completed') return null;

	if (name === 'hula_send_message') {
		return { action: 'sent', tool: 'hula_send_message' };
	}
	if (name === 'message') {
		// 本进程仅注册 hula channel；message 只可能投递到 hula，故不校验 channel。
		// 多 channel 场景下此判定会过计 send——后果是漏补 skip 而非误发消息。openclaw
		// 未来若在 item 事件暴露 args 再收紧。
		return { action: 'sent', tool: 'message' };
	}
	if (name === 'hula_skip_reply') {
		// item 事件不含 model 自填的 reason，固定为显式跳过原因（与兜底 'agent_no_terminal_tool' 区分）。
		return { action: 'skipped', tool: 'hula_skip_reply', reason: 'agent_skip_reply' };
	}
	return null;
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
	callbacks: ThinkingCallbacks;
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

	/** Negotiated protocol version reported by gateway hello-ok (v4) */
	private negotiatedProtocol: number | null = null;
	/** Connection id reported by gateway hello-ok (v4) */
	private connId: string | null = null;

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

	async chat(message: string, sessionKey: string, callbacks: ThinkingCallbacks, context?: ChatContext): Promise<void> {
		if (!this.connected || !this.ws) {
			callbacks.onError(new Error('openclaw gateway not connected'));
			return;
		}

		const requestId = randomUUID();
		const idempotencyKey = randomUUID();

		// 在 message 中注入角色分工说明（openclaw gateway 不支持 instructions 字段）
		// 注意：避免使用 [SYSTEM] / [System Message] 等标记，会被 openclaw 安全机制过滤
		// REQ-004 S3：从「强制 send」改为语义化的角色分工引导——仍优先引导 hula_send_message，
		// 但允许 hula_skip_reply 作为对等的合法终结动作（send 至少一次或 skip 恰好一次）。
		const roomIdHint = context?.roomId
			? `当前会话已绑定房间（room ${context.roomId}），hula_send_message 无需也不应再传 roomId。`
			: '';
		const enrichedMessage =
			'说明：你的正文输出是分析/思考过程，不会直接发给用户。' +
			'要回复用户时，请调用 hula_send_message 工具（已绑定当前房间，优先用它），把给用户看的内容写进 content。' +
			roomIdHint +
			'如果判断本轮无需回复（如纯客套、无实质内容、消息不需要回应），请调用 hula_skip_reply。' +
			'send 至少一次或 skip 恰好一次，二者是本轮的合法终结动作。\n\n' +
			'--- 用户消息如下 ---\n' + message;

		const params = {
			message: enrichedMessage,
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
			// diagnostic fields negotiated in hello-ok; reset per connection so a
			// reconnect that downgrades/changes connId does not keep stale values
			this.negotiatedProtocol = null;
			this.connId = null;
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
		// REQ-004 S3: item 流 → 终结动作检测（send / skip）。
		// openclaw 2026.6.5 实测：tool 调用走 `item` 流（不是 `tool`），故在此分流。
		if (evt.stream === 'item') {
			this.processItemStreamEvent(chat, evt);
			return;
		}
		// assistant 流 → thinking delta (REQ-004)
		if (evt.stream === 'assistant') {
			const delta = evt.data.delta as string | undefined;
			if (delta) {
				chat.fullContent += delta;
				chat.callbacks.onThinkingDelta(delta);
			}
		}
		// lifecycle 流 → thinking end (REQ-004)
		if (evt.stream === 'lifecycle' && !chat.done) {
			const phase = evt.data.phase as string | undefined;
			if (phase === 'end') {
				chat.done = true;
				const durationMs = Date.now() - chat.startTime;
				chat.callbacks.onThinkingEnd(durationMs);
				// P1-2 假设：openclaw 在 lifecycle phase==='end' 之前已投递本 run 内所有 tool 流
				// 事件（end 语义即"run 已完成"，按协议先于它的 tool result 都应已处理）。此处同步
				// cleanup 会丢弃 run:{runId}，若有 tool result 在 end 之后到达将找不到 chat 被丢弃
				// （→ 可能漏一次 send → 错误自动跳过）。当前未发现 openclaw 会乱序投递，故保留同步
				// cleanup；如后续观测到 result 晚于 end，需改为延迟 cleanup 或按 runId 暂存终结态。
				this.cleanupChatByRunId(evt.runId);
			} else if (phase === 'error') {
				chat.done = true;
				chat.callbacks.onError(new Error(evt.data.error as string || 'agent run failed'));
				this.cleanupChatByRunId(evt.runId);
			}
		}
	}

	/**
	 * REQ-004 S3: 处理 item 流事件，识别终结动作并回调 onTerminalTool。
	 *
	 * openclaw 2026.6.5 实测：一次 tool 调用产生两个 `item` 事件——phase:'start'（status:'running'）
	 * 与 phase:'end'（status:'completed' | 'failed'）。事件携带 name + status，**没有 args**。
	 * 只在 kind==='tool' 且 phase==='end' 时按 name+status 分类（start/running 忽略；
	 * 非 tool kind 如 command/patch/search/analysis 忽略）。无 args 可捕获，故无需 toolStarts 关联。
	 */
	private processItemStreamEvent(chat: PendingChat, evt: AgentEvent): void {
		const data = evt.data;
		if (data.kind !== 'tool') return;
		if (data.phase !== 'end') return;

		const name = data.name as string | undefined;
		const status = data.status as string | undefined;
		const classified = classifyTerminalTool(name, status);
		if (!classified) return;

		chat.callbacks.onTerminalTool?.({
			action: classified.action,
			tool: classified.tool,
			reason: classified.reason,
		});
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

		const params: Record<string, unknown> = buildConnectParams({
			token: this.token,
			device,
			role,
			scopes,
			platform,
		});

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
					const parsed = parseHelloOk(payload);
					if (parsed.ok) {
						if (typeof parsed.protocol === 'number') {
							this.negotiatedProtocol = parsed.protocol;
						}
						if (typeof parsed.connId === 'string') {
							this.connId = parsed.connId;
						}
						if (typeof parsed.tickIntervalMs === 'number') {
							this.tickIntervalMs = parsed.tickIntervalMs;
						}
						console.log(
							`[openclaw] Connected to gateway v${parsed.version ?? 'unknown'}` +
							` protocol=${parsed.protocol ?? 'unknown'} connId=${parsed.connId ?? 'unknown'}`,
						);
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
