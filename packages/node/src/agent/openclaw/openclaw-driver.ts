import WebSocket from 'ws';
import { randomUUID, createPrivateKey, sign, createPublicKey } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentEvent, AgentRun, PreparedRun, RunDriver } from '../events.js';
import { syncAgentsMdFile } from '../agents-md.js';
import { errMsg } from '../../util/err.js';

/**
 * REQ (openclaw empty thinking): upstream openclaw's built-in agent contract emits the literal
 * string `NO_REPLY` on its `assistant` text stream when it has no user-visible prose to add (the
 * reply itself already went out via the `aichat send-message` CLI); it ALSO emits a purely empty /
 * whitespace-only assistant stream on some turns. We consume that stream as thinking text, so both
 * the bare sentinel and an empty stream would otherwise land as a blank/broken thinking panel / DB
 * row. Filter both — but for the sentinel ONLY when the WHOLE thinking text is the sentinel
 * (openclaw's own regex is whole-string with optional surrounding whitespace), so a real thought
 * that merely CONTAINS "NO_REPLY" survives verbatim.
 *
 * Note: `.test()` on a non-global regex is stateless — do NOT add the `g` flag (lastIndex would
 * make repeated calls non-deterministic).
 */
export const OPENCLAW_NO_REPLY_SENTINEL = /^\s*NO_REPLY\s*$/;
/** Neutral placeholder for an openclaw turn with no real thinking prose (bare NO_REPLY sentinel OR
 *  empty/whitespace-only assistant stream). Deliberately makes NO claim about whether a reply was
 *  sent: the node can't know that at finalize time (reply goes out-of-band via the `aichat send-message`
 *  CLI), and empty-turns with no reply exist — so "回复已直接发出" would be false for them. */
export const OPENCLAW_EMPTY_THINKING_PLACEHOLDER = '（本轮无思考正文）';

/** openclaw-only: bare NO_REPLY sentinel OR empty/whitespace-only thinking → neutral placeholder;
 *  any real thinking (even if it merely CONTAINS "NO_REPLY") is returned verbatim. */
export function filterOpenclawThinking(content: string): string {
	return OPENCLAW_NO_REPLY_SENTINEL.test(content) || content.trim() === ''
		? OPENCLAW_EMPTY_THINKING_PLACEHOLDER
		: content;
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

/** A single agent stream event frame from the gateway (renamed from the wire's `agent` payload so
 *  it never collides with the driver-facing `AgentEvent` vocabulary this file also emits). */
interface GatewayAgentEvent {
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

/**
 * The push→pull sink an in-flight turn writes its AgentEvents into. Owned by an OpenclawSession's
 * send() queue; the driver's gateway engine translates its wire events (assistant deltas →
 * `thinking`, lifecycle `phase:end` → `done`, `phase:error` → `error`) into pushes on this sink.
 */
interface ChatSink {
	push: (ev: AgentEvent) => void;
	finish: () => void;
}

/**
 * One active agent turn tracked by the gateway engine. Holds the session sink it delivers into
 * (instead of the retired ThinkingCallbacks) plus the run bookkeeping.
 */
interface PendingChat {
	sink: ChatSink;
	done: boolean;
	startTime: number; // REQ-004: 用于计算 thinking durationMs
	/**
	 * aichatoverview#166: 放弃-run 兜底定时。gateway 若永不投递本 run 的 lifecycle end/error（agent 崩/
	 * 掉 run），三 map 条目会活到连接断开（长稳单调泄漏）。到点终结 sink + cleanup。正常终结时清定时。
	 */
	timeout?: ReturnType<typeof setTimeout>;
}

/** Factory for the underlying gateway WebSocket. Injectable so tests can drive scripted frames
 *  without a live socket; the default builds the real `ws` socket with the production maxPayload. */
export type OpenclawSocketFactory = (url: string) => WebSocket;

const defaultOpenclawSocketFactory: OpenclawSocketFactory = (url) =>
	new WebSocket(url, { maxPayload: 25 * 1024 * 1024 });

/** aichatoverview#166: abandoned-run backstop, aligned with the handler's 5-min thinking-session cap. */
const OPENCLAW_CHAT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * OpenclawDriver — the openclaw AgentDriver (aichatoverview#162).
 *
 * Melts what used to be three layers (the imagined `ClawAdapter` seam + `OpenclawAdapter` gateway
 * engine + a thin wrapper driver) into ONE driver that owns the gateway WS engine and emits
 * `AgentEvent` natively — matching the opencode/codex/cc drivers' directory-and-shape convention.
 *
 * It connects to the openclaw gateway via WebSocket RPC with a device identity signature (v3
 * payload) + token auth, negotiates protocol v4, and streams each turn's assistant text as
 * `thinking` AgentEvents with a `done`/`error` terminal.
 */
// ponytail: one global AGENTS.md scope per workspace; permit multi-identity concurrency only
// when a pinned gateway proves per-session prompt isolation and provides an isolated injection API.
const promptOwners = new Map<string, string>();
const promptActive = new Map<string, { owner: string; prompt: string; count: number }>();
const promptWrites = new Map<string, Promise<void>>();

export class OpenclawDriver implements RunDriver {
	readonly type = 'openclaw';
	readonly features = { cancel: 'unsupported', reset: 'supported', promptUpdate: 'per-run' } as const;

	private ws: WebSocket | null = null;
	private url: string;
	private token: string;
	private readonly wsFactory: OpenclawSocketFactory;
	/**
	 * REQ-018 R1（真机已确认）: openclaw 实际读取的工作区是 `~/.openclaw/workspace/`，会话启动时把其中的
	 * AGENTS.md / SOUL.md / USER.md 等语义文件注入上下文 —— 所以渲染后的 system prompt 必须写进
	 * `~/.openclaw/workspace/AGENTS.md`。workspace 是全局单目录，多个 openclaw 身份共享一份 AGENTS.md
	 * 会互踩（aichatoverview#219）；单身份下无互踩，不阻塞。
	 */
	private readonly workspaceDir: string;
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
	/** Early frames are keyed by real gateway runId, never assigned to an arbitrary pending request. */
	private earlyEvents = new Map<string, GatewayAgentEvent[]>();
	private earlyOverflow = new Set<string>();
	private earlyOverflowGlobal = false;

	/** Resolve function for initial connect() promise */
	private connectResolve: (() => void) | null = null;
	private connectReject: ((err: Error) => void) | null = null;

	constructor(
		url: string,
		token: string,
		wsFactory: OpenclawSocketFactory = defaultOpenclawSocketFactory,
		// REQ-018 R1: openclaw workspace dir for the AGENTS.md system prompt (defaults to ~/.openclaw/workspace).
		workspaceDir?: string,
		private readonly assertPromptOwner?: (conversationId: string, workspace: string, identityId: string) => void,
	) {
		this.url = url;
		this.token = token;
		this.wsFactory = wsFactory;
		this.workspaceDir = workspaceDir ?? resolve(homedir(), '.openclaw', 'workspace');
	}

	/** Core owns the native gateway key; the legacy binding store is not consulted by this path. */
	createRun(input: PreparedRun): AgentRun {
		if (!input.runId || !input.conversation || !input.signal || typeof input.message !== 'string' ||
			!/^aiclaw-\d+-room-\d+$/.test(input.transcriptKey ?? '') ||
			!(/^[0-9a-f]{64}$/.test(input.contextKey ?? '')) || typeof input.systemPrompt !== 'string')
			throw new TypeError('Invalid OpenClaw prepared run');
		let consumed = false, submitted = false, completed = false, cancelled = input.signal.aborted;
		let session: OpenclawSession | undefined;
		const workspace = process.platform === 'win32' ? resolve(this.workspaceDir).toLowerCase() : resolve(this.workspaceDir);
		const onAbort = () => { void run.cancel('aborted'); };
		input.signal.addEventListener('abort', onAbort, { once: true });
		const run: AgentRun = {
			events: { [Symbol.asyncIterator]: () => {
				if (consumed) throw new Error('OpenClaw run events can be consumed only once');
				consumed = true;
				return execute();
			} },
			async cancel(reason) {
				cancelled = true;
				await session?.close(); // Local stream wake, NOT proof of gateway cancellation.
				return completed || !submitted ? { status: 'stopped' } :
					{ status: 'unconfirmed', reason: `${reason}: OpenClaw gateway run stop not verified` };
			},
			async dispose() {
				input.signal.removeEventListener('abort', onAbort);
				if (!completed) await run.cancel('dispose');
			},
		};
		const execute = async function* (this: OpenclawDriver): AsyncGenerator<AgentEvent> {
			let held = false;
			try {
				if (cancelled || input.signal.aborted) { yield { type: 'cancelled', reason: 'Cancelled before submission' }; return; }
				const previous = input.conversation.nativeState?.value;
				if (previous !== undefined && (!previous || typeof previous !== 'object' ||
					!('token' in previous) || typeof previous.token !== 'string' ||
					!('nativeRef' in previous) || typeof previous.nativeRef !== 'string' ||
					!previous.nativeRef.startsWith(`${previous.token}:`)))
					throw new Error('OpenClaw nativeRef invalid; explicit reset required (history retained)');
				// The old full compound is opaque history. Never derive identity by parsing its tail.
				const token = previous && typeof previous === 'object' && 'token' in previous
					? previous.token as string : input.contextKey!;
				const nativeRef = previous && typeof previous === 'object' && 'nativeRef' in previous
					? previous.nativeRef as string : `${token}:${input.transcriptKey}`;
				const identityId = input.promptOwner ?? input.conversation.id;
				this.assertPromptOwner?.(input.conversation.id, workspace, identityId);
				const owner = promptOwners.get(workspace);
				if (owner && owner !== identityId) throw new Error('PROMPT_SCOPE_CONFLICT: shared OpenClaw AGENTS.md belongs to another identity');
				const active = promptActive.get(workspace);
				if (active && (active.owner !== identityId || active.prompt !== input.systemPrompt))
					throw new Error('PROMPT_SCOPE_CONFLICT: active OpenClaw run uses another identity or prompt');
				promptActive.set(workspace, { owner: identityId, prompt: input.systemPrompt, count: (active?.count ?? 0) + 1 }); held = true;
				input.conversation.assertCurrent();
				if (cancelled || input.signal.aborted) { yield { type: 'cancelled', reason: 'Cancelled before submission' }; return; }
				if (!previous) {
					if (!input.conversation.registerNative) throw new Error('OpenClaw atomic native registration unavailable');
					await input.conversation.registerNative(token, { version: 1, value: { token, nativeRef } });
				}
				// Publish sticky ownership only after core actually owns a native history.
				promptOwners.set(workspace, identityId);
				await input.saveRecovery({ version: 1, value: { provider: 'openclaw', runId: input.runId,
					nativeRef, stopProbe: 'unconfirmed' } });
				input.conversation.assertCurrent();
				if (cancelled || input.signal.aborted) { yield { type: 'cancelled', reason: 'Cancelled before submission' }; return; }
				// A shared gateway workspace offers only a mutable AGENTS.md. Failure must block submission,
				// not silently run under a previous identity's prompt.
				let writing = promptWrites.get(workspace);
				if (!writing) {
					writing = syncAgentsMdFile(join(this.workspaceDir, 'AGENTS.md'), input.systemPrompt).then(() => {});
					promptWrites.set(workspace, writing);
					void writing.finally(() => { if (promptWrites.get(workspace) === writing) promptWrites.delete(workspace); }).catch(() => {});
				}
				await writing;
				input.conversation.assertCurrent();
				if (cancelled || input.signal.aborted) { yield { type: 'cancelled', reason: 'Cancelled before submission' }; return; }
				session = new OpenclawSession((message, sink) => this.beginChat(message, nativeRef, sink, () => { submitted = true; }),
					() => input.conversation.assertCurrent());
				const stream = session.send(input.message);
				let terminal: AgentEvent | undefined;
				for await (const event of stream) {
					if (cancelled) { yield { type: 'cancelled', reason: 'OpenClaw stop not confirmed' }; return; }
					if (event.type === 'done' || event.type === 'error' || event.type === 'cancelled') terminal = event;
					else if (!terminal) yield event;
				}
				if (cancelled) yield { type: 'cancelled', reason: 'OpenClaw stop not confirmed' };
				else if (terminal?.type === 'done') { completed = true; yield terminal; }
				else yield terminal ?? { type: 'error', message: 'UNEXPECTED_EOF: OpenClaw gateway did not confirm completion' };
			} catch (error) {
				yield { type: 'error', message: errMsg(error) };
			} finally {
				input.signal.removeEventListener('abort', onAbort);
				if (held) {
					const active = promptActive.get(workspace)!;
					if (active.count === 1) promptActive.delete(workspace);
					else promptActive.set(workspace, { ...active, count: active.count - 1 });
				}
				if (!completed) void session?.close();
			}
		}.bind(this);
		return run;
	}

	/** Keep gateway-specific NO_REPLY normalization out of the generic message handler. */
	finalizeThinking(content: string): string {
		return filterOpenclawThinking(content);
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
		this.flushPendingErrors(new Error('driver disconnected'));
		this.ws?.close();
		this.ws = null;
	}

	get isConnected(): boolean {
		return this.connected;
	}

	/**
	 * Begin one in-flight agent turn over the gateway, delivering its AgentEvents into `sink`.
	 * Called by an OpenclawSession's send(); the gateway's streamed reply is mapped to the sink by
	 * processAgentStreamEvent (assistant → thinking, lifecycle end/error → done/error).
	 */
	private beginChat(message: string, sessionKey: string, sink: ChatSink, onSubmit?: () => void): void {
		if (!this.connected || !this.ws) {
			sink.push({ type: 'error', message: 'openclaw gateway not connected' });
			sink.finish();
			return;
		}

		const requestId = randomUUID();
		const idempotencyKey = randomUUID();

		// aichatoverview#161：回复统一走 CLI（`aichat send-message`），不再引导已退役的
		// hula_send_message / hula_skip_reply 工具。房间/身份由 exec-env 的 OPENCLAW_BIND 绑定。
		// REQ-018：per-turn message 是纯用户文本 —— 回复契约 + 身份锚 + 人设已渲染进 openSession 写入的
		// workspace AGENTS.md（legacy openSession 或 native createRun 准备阶段），不再给 gateway message 加前缀。
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
					chat.sink.push({ type: 'error', message: errMsg(err) });
					chat.sink.finish();
					this.cleanupChat(requestId);
				}
			},
			expectFinal: true,
			timeout: null,
		});

		// 预注册 chat state + 放弃-run 兜底定时（gateway 永不终结本 run 时到点回收三 map，防长稳泄漏）。
		// .unref()：兜底定时不应单独把进程钉活（正常终结会清它）。
		this.requestToRunId.set(requestId, '');
		const chat: PendingChat = { sink, done: false, startTime: Date.now() };
		chat.timeout = setTimeout(() => this.expireChat(requestId), OPENCLAW_CHAT_TIMEOUT_MS);
		chat.timeout.unref?.();
		this.activeChats.set(`req:${requestId}`, chat);

		// The frame may start native work synchronously. A local not-connected error above
		// never marks submission; a send failure after this point has unknown delivery.
		onSubmit?.();
		try { this.ws.send(JSON.stringify(frame)); }
		catch (error) {
			chat.done = true;
			sink.push({ type: 'error', message: errMsg(error) });
			sink.finish();
			this.cleanupChat(requestId);
		}
	}

	// ─── WebSocket lifecycle ───

	private startWs(): void {
		if (this.closed) return;

		const ws = this.wsFactory(this.url);
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
			const agentEvt = evt.payload as unknown as GatewayAgentEvent;
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

	private handleAgentEvent(evt: GatewayAgentEvent): void {
		const chat = this.activeChats.get(`run:${evt.runId}`);
		if (chat) { this.processAgentStreamEvent(chat, evt); return; }
		// A gateway can deliver stream frames before its accepted response. Without the response's
		// requestId→runId association, guessing the first pending request can cross-route identities.
		if (![...this.requestToRunId.values()].includes('')) return;
		if (this.earlyOverflow.has(evt.runId)) return;
		const buffered = this.earlyEvents.get(evt.runId) ?? [];
		if (buffered.length >= 64) { this.earlyEvents.delete(evt.runId); this.earlyOverflow.add(evt.runId); return; }
		if (this.earlyEvents.size >= 16 && !buffered.length) { this.earlyOverflowGlobal = true; return; }
		buffered.push(evt);
		this.earlyEvents.set(evt.runId, buffered);
	}

	private processAgentStreamEvent(chat: PendingChat, evt: GatewayAgentEvent): void {
		// aichatoverview#161: item 流曾用于终结动作分类（send/skip），随工具退役已无消费者
		// （onTerminalTool 自 REQ-010 S1 起未桥接；回复改走 CLI 由 node CapabilityEndpoint 记账）。
		// assistant 流 → thinking delta (REQ-004)
		if (evt.stream === 'assistant') {
			const delta = evt.data.delta as string | undefined;
			if (delta) {
				chat.sink.push({ type: 'thinking', text: delta });
			}
		}
		// lifecycle 流 → thinking end (REQ-004)
		if (evt.stream === 'lifecycle' && !chat.done) {
			const phase = evt.data.phase as string | undefined;
			if (phase === 'end') {
				chat.done = true;
				const durationMs = Date.now() - chat.startTime;
				chat.sink.push({ type: 'done', durationMs });
				chat.sink.finish();
				// P1-2 假设：openclaw 在 lifecycle phase==='end' 之前已投递本 run 内所有 tool 流
				// 事件（end 语义即"run 已完成"，按协议先于它的 tool result 都应已处理）。此处同步
				// cleanup 会丢弃 run:{runId}，若有 tool result 在 end 之后到达将找不到 chat 被丢弃
				// （→ 可能漏一次 send → 错误自动跳过）。当前未发现 openclaw 会乱序投递，故保留同步
				// cleanup；如后续观测到 result 晚于 end，需改为延迟 cleanup 或按 runId 暂存终结态。
				this.cleanupChatByRunId(evt.runId);
			} else if (phase === 'error') {
				chat.done = true;
				chat.sink.push({ type: 'error', message: (evt.data.error as string) || 'agent run failed' });
				chat.sink.finish();
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
			if (this.earlyOverflowGlobal || this.earlyOverflow.delete(runId)) {
				chat.done = true;
				chat.sink.push({ type: 'error', message: 'OPENCLAW_EARLY_STREAM_OVERFLOW: gateway event correlation incomplete' });
				chat.sink.finish();
				this.cleanupChat(requestId);
				return;
			}
			const buffered = this.earlyEvents.get(runId) ?? [];
			this.earlyEvents.delete(runId);
			for (const event of buffered) { if (!chat.done) this.processAgentStreamEvent(chat, event); }
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

	/**
	 * aichatoverview#166: the abandoned-run backstop fired — the gateway never sent this run's terminal.
	 * Finish the sink with an error (wake any parked consumer) if still open, then reclaim the three maps.
	 *
	 * Window-race safety (#74 review P2): a normal terminal that lands in the SAME tick the timer fires
	 * clears it via cleanupChatByRunId, so expireChat only runs when the run is genuinely abandoned. If a
	 * late terminal still races in, `findChatByRequestId` may return undefined (already cleaned) → the sink
	 * block is skipped; `chat.done` guards a double-finish; and cleanupChat is idempotent (delete-if-present
	 * on all three maps). So expireChat is safe to run even against a partially/fully cleaned chat.
	 */
	private expireChat(requestId: string): void {
		const chat = this.findChatByRequestId(requestId);
		if (chat && !chat.done) {
			chat.done = true;
			chat.sink.push({ type: 'error', message: 'openclaw_chat_timeout' });
			chat.sink.finish();
		}
		this.cleanupChat(requestId);
	}

	private cleanupChat(requestId: string): void {
		const chat = this.findChatByRequestId(requestId);
		if (chat?.timeout) clearTimeout(chat.timeout);
		this.activeChats.delete(`req:${requestId}`);
		const runId = this.requestToRunId.get(requestId);
		if (runId) {
			this.activeChats.delete(`run:${runId}`);
		}
		this.requestToRunId.delete(requestId);
		if (![...this.requestToRunId.values()].includes('')) {
			this.earlyEvents.clear(); this.earlyOverflow.clear(); this.earlyOverflowGlobal = false;
		}
		this.pending.delete(requestId);
	}

	private cleanupChatByRunId(runId: string): void {
		// aichatoverview#166: clear the abandoned-run backstop on normal termination (req:/run: point to the
		// SAME PendingChat, so either key clears the one timer).
		const chat = this.activeChats.get(`run:${runId}`);
		if (chat?.timeout) clearTimeout(chat.timeout);
		this.activeChats.delete(`run:${runId}`);
		for (const [reqId, rId] of this.requestToRunId) {
			if (rId === runId) {
				const reqChat = this.activeChats.get(`req:${reqId}`);
				if (reqChat?.timeout) clearTimeout(reqChat.timeout);
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
				chat.sink.push({ type: 'error', message: err.message });
				chat.sink.finish();
			}
		}
		this.activeChats.clear();
		this.requestToRunId.clear();
		this.earlyEvents.clear();
		this.earlyOverflow.clear();
		this.earlyOverflowGlobal = false;
	}
}

/**
 * One in-flight agent turn over the OpenclawDriver's gateway engine (single-flight for this slice).
 * send() returns an async iterable backed by a minimal push→pull queue so events fired by the
 * engine (possibly synchronously, before the consumer awaits) are buffered and never lost.
 */
class OpenclawSession {
	private closed = false;
	/**
	 * REQ-008 #75 P1-1①: the in-flight stream's `finish` closure, registered when
	 * send() starts. close() calls it to wake a consumer parked on the await inside
	 * the async iterator (single-flight per session for this slice). Calling finish
	 * twice is a no-op (it guards on `done`), so this stays idempotent; after a send
	 * completes a stale closeActive pointing at an already-finished stream is harmless.
	 */
	private closeActive: (() => void) | null = null;

	/**
	 * `startChat` begins a turn on the shared gateway engine, delivering its AgentEvents into the
	 * sink send() hands it. The driver builds this closure in openSession (capturing the compound
	 * sessionKey) so the gateway engine stays encapsulated on the driver.
	 */
	constructor(
		private readonly startChat: (message: string, sink: ChatSink) => void,
		private readonly assertRunCurrent?: () => void,
	) {}

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
		// Register this stream's finish so close() can wake a parked iterator.
		this.closeActive = finish;

		// Fire the turn on the gateway engine. The engine maps the streamed gateway reply into
		// AgentEvents on this sink: assistant deltas → `thinking`; lifecycle phase:end → `done`
		// (then finish); phase:error / any engine-side failure → `error` (then finish).
		// REQ-010 S1 / aichatoverview#161: no terminal AgentEvent — the openclaw agent sends its
		// reply out-of-band by running `aichat send-message` (accounted at the node's
		// CapabilityEndpoint), so there is no in-stream terminal tool to bridge.
		this.assertRunCurrent?.();
		this.startChat(message, { push, finish });

		const isClosed = () => this.closed;

		return {
			async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
				while (true) {
					while (buffer.length > 0) {
						yield buffer.shift()!;
					}
					if (done || isClosed()) return;
					await new Promise<void>((resolve) => {
						resolveNext = resolve;
					});
				}
			},
		};
	}

	async close(): Promise<void> {
		this.closed = true;
		// REQ-008 #75 P1-1①: wake a consumer parked on the await inside the iterator.
		// finish() marks done + wakes the pending resolveNext; the iterator then drains
		// any remaining buffer (drain-before-done ordering preserved) and returns.
		// Idempotent: finish guards on `done`, so a repeat / post-completion call is a no-op.
		if (this.closeActive) this.closeActive();
	}
}
