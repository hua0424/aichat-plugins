import { type IncomingMessage } from 'http';
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
	 * #184 身份标识（仅用于日志上报）。HuLa-Server gateway 会把 aiclaw token 校验失败包装成
	 * HTTP 200 + JSON body {success:false,code:406,…}；为避免 43 分钟级静默重试，permanent 分支
	 * 必须 WARN 上报，且日志里要带身份 uid 才分得清是哪条身份出问题。
	 */
	uid?: string;
	/**
	 * #152 半开检测看门狗：每隔多久发一次 ws ping 帧并检查存活（默认 30s）。
	 * 与应用层 25s HEARTBEAT 是两回事——后者防服务端踢，本 ping 只探本端 socket 是否半开。
	 */
	pingIntervalMs?: number;
	/** #152 距上次收到任意入站帧超过此阈值即判定半开、强制 terminate 触发重连（默认 60s）。 */
	deadAfterMs?: number;
	/**
	 * #459 TCP/TLS 已建连但 upgrade 迟迟不结束时的等待预算（默认 10s）。
	 *
	 * 依据：同一 DC/内网的 upgrade 正常在 ms 级完成；既有事故证据（#152/#184）里的失败形态是
	 * 立即 ECONNREFUSED 或网关 200/5xx，而不是慢握手，所以 10s 已能容忍网关启动期的 GC/Nacos
	 * 注册抖动，同时保证一次恢复周期有界：最坏 10s 握手 + 5s body（见下）+ 最高 30s 退避。
	 * 超时走 ws 的 'error'('Opening handshake has timed out') → 既有 'close' → backoff 重连，
	 * 不新增重试框架。
	 */
	handshakeTimeoutMs?: number;
	/**
	 * #459 非 101 响应的 **body** 读取预算（默认 5s）。
	 *
	 * 依据：gateway 的错误包装 body（{success:false,code:406,…}）不足 1KB、单包即到；5s 是
	 * 5× 单包 RTT/GC 余量。超时按「body 不完整」处理（见 classifyHandshakeFailure）：不拿截断
	 * body 的业务 code 判 permanent，只允许 HTTP 状态码 401/403/406 短路，其余按 transient
	 * 退避重试，避免 body 一直不结束时恢复链路永久悬挂（#459 复现候选之一）。
	 */
	handshakeBodyTimeoutMs?: number;
	/** #459 重连退避起点（测试可注入小值；生产缺省 1000ms，曲线与既有实现一致）。 */
	reconnectBaseDelayMs?: number;
	/** #459 重连退避上限（测试可注入小值；生产缺省 30000ms，曲线与既有实现一致）。 */
	maxReconnectDelayMs?: number;
}

/** #459 握手等待预算（见 HulaWSClientOptions.handshakeTimeoutMs 的依据）。 */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
/** #459 非 101 响应 body 读取预算（见 HulaWSClientOptions.handshakeBodyTimeoutMs 的依据）。 */
const DEFAULT_HANDSHAKE_BODY_TIMEOUT_MS = 5_000;
/** 既有重连曲线起点/上限（#459 只把它们变成可注入，数值与行为不变）。 */
const DEFAULT_RECONNECT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000;

/**
 * #459 日志里的目标端点：去掉 userinfo/query/hash，只留 scheme://host/path。
 * token/clientId 走 header 与 sub-protocol，但配置里的 URL 仍可能带凭据参数 —— 日志永不回显。
 */
function sanitizeEndpoint(raw: string): string {
	try {
		const u = new URL(raw);
		return `${u.protocol}//${u.host}${u.pathname}`;
	} catch {
		return '<unparsable-url>';
	}
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
	private reconnectDelay: number;
	private readonly maxReconnectDelay: number;
	private closed = false;
	/** #459 目标端点（已去凭据）与连接代次，二者只用于可归属的恢复日志。 */
	private readonly endpoint: string;
	private connectAttempt = 0;
	/** #459 close() 代次，用于丢弃「停止之后才回来」的异步分类结果。 */
	private stopEpoch = 0;
	private readonly handshakeTimeoutMs: number;
	private readonly handshakeBodyTimeoutMs: number;
	/** #152 上次收到任意入站帧（open/pong/message）的时刻；看门狗据此判定半开。 */
	private lastAliveAt = 0;
	private readonly pingIntervalMs: number;
	private readonly deadAfterMs: number;
	/**
	 * #184 握手失败分析进行中标记。ws 在 'unexpected-response' 之后仍会 emit 'close'(1006)；
	 * 但响应体（含决定 permanent/transient 的业务 code）要异步读完。该标记让 'close' handler
	 * 在分类未定之前先不 scheduleReconnect，由 classify 统一收口（避免 permanent 时被 'close'
	 * 抢先重连、也避免 transient 时双重 timer——scheduleReconnect 自带幂等兜底）。
	 */
	private handshakeFailurePending = false;
	/** #184 连续 transient 握手失败计数；'open' 成功即重置。达阈值即 WARN 告警。 */
	private transientHandshakeCount = 0;
	/** #184 连续 transient 握手失败告警阈值（manager 裁决：不永久停，只告警）。 */
	private static readonly TRANSIENT_HANDSHAKE_WARN_THRESHOLD = 10;

	constructor(options: HulaWSClientOptions) {
		this.options = options;
		this.pingIntervalMs = options.pingIntervalMs ?? 30000;
		this.reconnectDelay = options.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS;
		this.maxReconnectDelay = options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
		this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
		this.handshakeBodyTimeoutMs = options.handshakeBodyTimeoutMs ?? DEFAULT_HANDSHAKE_BODY_TIMEOUT_MS;
		this.endpoint = sanitizeEndpoint(options.url);
		let deadAfterMs = options.deadAfterMs ?? 60000;
		// P1-5: deadAfterMs must exceed pingIntervalMs, otherwise the watchdog declares
		// the connection dead before a single ping round-trip can refresh liveness —
		// false-killing a perfectly healthy socket. This is a long-running background
		// service, so we do NOT throw on a config typo; we clamp and warn once.
		if (deadAfterMs <= this.pingIntervalMs) {
			const clamped = this.pingIntervalMs * 2;
			console.warn(
				`[hula-ws] deadAfterMs (${deadAfterMs}ms) <= pingIntervalMs (${this.pingIntervalMs}ms) ` +
					`would false-kill a healthy connection; clamping deadAfterMs ${deadAfterMs}ms → ${clamped}ms`,
			);
			deadAfterMs = clamped;
		}
		this.deadAfterMs = deadAfterMs;
	}

	connect(): void {
		this.closed = false;
		// P1-1: defensively tear down any lingering timers from a previous cycle before
		// starting a new socket. A reconnect path could otherwise leak a stale interval.
		// stop*() on null timers is a safe no-op, so first-connect is unaffected.
		this.stopHeartbeat();
		this.stopWatchdog();
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		const previous = this.ws;
		// #459 上一代握手分类未定就换连接：旧代次的收口必须作废，不能作用到新连接。
		this.handshakeFailurePending = false;
		this.connectAttempt += 1;
		this.log('connecting', `attempt=${this.connectAttempt}`);

		// CR-M1: token 走 header，clientId 走 sub-protocol，不再暴露在 URL query 中
		// #459 handshakeTimeout：TCP 已建连但 upgrade 不结束时由 ws 自己 abort（'Opening handshake
		// has timed out'），落回既有 'error' → 'close' → backoff 重连，不新增重试框架。
		const ws = new WebSocket(
			this.options.url,
			['aiclaw-v1', `clientId_${this.options.clientId}`],
			{ headers: { 'Token': this.options.token }, handshakeTimeout: this.handshakeTimeoutMs }
		);
		this.ws = ws;

		// #459 代次守卫：旧 socket 的任何迟到事件（open/message/pong/close/error/握手响应）都不得
		// 触碰当前连接 —— 否则旧 'close' 会停掉新连接的心跳、旧 'message' 会重复投递、旧响应
		// 会把当前连接判成 permanent。事件处理只在 ws 仍是 this.ws 时生效。
		const isCurrent = (): boolean => this.ws === ws;

		ws.on('open', () => {
			if (!isCurrent()) return;
			this.log('connected', `attempt=${this.connectAttempt}`);
			this.reconnectDelay = this.options.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS;
			// #184 a successful connect resets the transient-handshake counter so a later burst
			// after recovery does not false-alarm the threshold WARN.
			this.transientHandshakeCount = 0;
			this.lastAliveAt = Date.now();
			this.startHeartbeat();
			this.startWatchdog();
			this.options.onConnected?.();
		});

		// #184 ws emits 'unexpected-response'(req, res) when the upgrade is answered with a
		// non-101 status. Registering this listener suppresses ws's fallback 'error' emit for
		// handshake failures (ws@8.19 verified), so ALL handshake classification lives here now.
		// res is the http.IncomingMessage — statusCode is sync; body chunks arrive via 'data'/'end'.
		ws.on('unexpected-response', (_req, res) => {
			if (!isCurrent()) return;
			this.handleHandshakeFailure(ws, res);
		});

		// #152 ws 协议层 pong（对我们主动 ping 的回应）证明本端 socket 仍活
		ws.on('pong', () => {
			if (!isCurrent()) return;
			this.lastAliveAt = Date.now();
		});

		ws.on('message', (data) => {
			if (!isCurrent()) return;
			// #152 任意入站帧都证明连接存活，避免慢速但正常的流量被误杀
			this.lastAliveAt = Date.now();
			try {
				const msg = JSON.parse(data.toString()) as WSResponse;
				this.options.onMessage(msg);
			} catch (err) {
				console.error('[hula-ws] Failed to parse message:', err);
			}
		});

		ws.on('close', (code, reason) => {
			if (!isCurrent()) return;
			this.log('disconnected', `code=${code} reason=${reason.toString()}`);
			this.stopHeartbeat();
			this.stopWatchdog();
			this.options.onDisconnected?.();
			if (this.closed) return;
			// #184 a handshake failure is being analyzed (body still being read) — defer the
			// reconnect decision to classifyHandshakeFailure so a permanent 200+body result is
			// not raced into a reconnect by this 'close'. classify will scheduleReconnect for
			// transient (idempotent) or set this.closed for permanent.
			if (this.handshakeFailurePending) return;
			this.scheduleReconnect();
		});

		ws.on('error', (err) => {
			if (!isCurrent()) return;
			console.error(`[hula-ws] uid=${this.options.uid ?? '?'} stage=disconnected endpoint=${this.endpoint} Error: ${err.message}`);
			// P1-2 + #184: any WS error means this connection is going down — stop the liveness
			// timers so no interval survives on a dead/erroring socket. Handshake (non-101) failures
			// are now handled by 'unexpected-response' (registering that listener suppresses ws's
			// fallback 'error' for handshakes in ws@8.19+), so this handler only sees transport-level
			// errors (ECONNRESET/ECONNREFUSED/handshake timeout/etc.). The follow-up 'close'(1006)
			// drives scheduleReconnect.
			this.stopHeartbeat();
			this.stopWatchdog();
		});

		// #459 一个身份同一时刻只保留一个当前连接：新 socket 就位后再 terminate 上一代，
		// 使上一代的迟到事件因代次不匹配被丢弃（旧实现会让两个连接短暂并行服务同一身份）。
		if (previous && previous !== ws && previous.readyState !== WebSocket.CLOSED) {
			this.log('retrying', 'terminating superseded socket before new attempt');
			previous.terminate();
		}
	}

	/**
	 * #184 收到 ws 'unexpected-response'(非 101 握手失败)。同步取 statusCode 后异步读完响应体，
	 * 再交 classifyHandshakeFailure 分类。body 读取期间置 handshakeFailurePending，让 'close'
	 * handler 不要抢先 scheduleReconnect（permanent 时会被误重连、transient 时会重复 timer）。
	 *
	 * HuLa-Server gateway 的 TokenContextFilter 故意把 aiclaw token 校验失败包装成
	 * HTTP 200 + JSON body {success:false,code:406,msg:"token已过期"}；旧实现只从 'error' 的
	 * err.message 解析 "Unexpected server response: 200"，把 200 当 transient rewarm 无限重试
	 * （生产 codex 静默重试 43 分钟）。这里读 body 拿业务 code 来区分 permanent / transient。
	 *
	 * #459 body 读取有界：旧实现完全依赖 'end'/'error'；网关把响应头发完却永不结束 body 时，
	 * handshakeFailurePending 永久为 true → 'close' 永不重连 → 恢复链路永久悬挂。超时后按
	 * 「body 不完整」分类（partial body 不可信，只允许 HTTP 状态码短路 permanent），再走既有 transient 路径。
	 */
	private handleHandshakeFailure(ws: WebSocket, res: IncomingMessage): void {
		const statusCode = res.statusCode ?? 0;
		// 握手失败的 socket 已废，立刻停活性定时器（与 'close' 路径一致）。
		this.stopHeartbeat();
		this.stopWatchdog();
		this.handshakeFailurePending = true;

		const chunks: Buffer[] = [];
		let classified = false;
		let bodyTimer: ReturnType<typeof setTimeout> | null = null;
		const classifyOnce = (bodyComplete: boolean, how: string): void => {
			if (classified) return;
			classified = true;
			if (bodyTimer) {
				clearTimeout(bodyTimer);
				bodyTimer = null;
			}
			const bodyText = Buffer.concat(chunks).toString('utf8');
			if (!bodyComplete) {
				console.warn(
					`[hula-ws] uid=${this.options.uid ?? '?'} stage=handshake endpoint=${this.endpoint} ` +
						`http=${statusCode} body incomplete (${how}) — classification uses http status only`,
				);
			}
			void this.classifyHandshakeFailure(ws, statusCode, bodyText, res, bodyComplete).catch((e) =>
				console.error('[hula-ws] classifyHandshakeFailure failed:', e),
			);
		};
		bodyTimer = setTimeout(() => classifyOnce(false, `no body end within ${this.handshakeBodyTimeoutMs}ms`), this.handshakeBodyTimeoutMs);
		// body 定时器不应阻止进程退出（与既有 heartbeat/重连定时器不同：它只等待收尾，不承担业务）。
		bodyTimer.unref?.();
		res.on('data', (c: Buffer) => chunks.push(c));
		res.on('end', () => classifyOnce(true, 'end'));
		// 响应体读取异常（截断等）→ 用已收到的部分按 transient 分类，不阻塞重连。
		res.on('error', () => classifyOnce(false, 'body error'));
		// 连接在 body 读完前被 abort 时 IncomingMessage 只 emit 'aborted'，不保证 'end'。
		res.on('aborted', () => classifyOnce(false, 'aborted'));
	}

	/**
	 * #184 分类握手失败。#184(b) P1 改白名单：仅当 statusCode∈{401,403,406} 或
	 * body.code∈{401,403,406,40001,100000004,100000005} 才判 permanent（身份真的失效）；
	 * 其余一律 transient——包括 success===false 但 code=-1（gateway 默认异常包装）/ code=502 /
	 * code=503（网关瞬态、启动空窗）。旧宽判定 `success===false || code>=400` 把网关瞬态熔断成
	 * 永久离线，是 #152 事故复活，已删。
	 *
	 * #184(b) P2:读完 body、分类后调 res.socket?.destroy() 释放底层 socket（防泄漏）；
	 * transient 分支显式调 onDisconnected?.()——握手失败瞬态窗口里 supervisor 不能虚报 online。
	 * permanent 分支走 onAuthError→degrade 不受影响。
	 *
	 * #459 收口守卫：body 读取期间可能已经换过代次（重连成功）或已 close()（supervisor 停止/
	 * degrade）。旧代次的迟到分类必须只做资源清理，不得触碰当前状态——否则迟到 permanent 会把
	 * 重新健康的连接永久断路（而不是停止实例），迟到 transient 会给新连接再排一个重连定时器。
	 * body 不完整（超时/abort/读错误）时不得用截断 body 的业务 code 判 permanent，只承认 HTTP 状态码。
	 */
	private async classifyHandshakeFailure(
		ws: WebSocket,
		statusCode: number,
		bodyText: string,
		res: IncomingMessage,
		bodyComplete: boolean,
	): Promise<void> {
		const uid = this.options.uid ?? '?';
		// 兜底释放底层 socket（各路径都可能在分类前后被 close/换代）。
		res.socket?.destroy();
		if (this.ws !== ws || this.closed) {
			this.log(
				this.closed ? 'stopped' : 'retrying',
				`ignoring late handshake result http=${statusCode} from superseded connection`,
			);
			// 旧代次的 pending 闸门已不属于当前状态，只有当前连接才解除（connect() 换代会重置它）。
			return;
		}
		// 分类一旦落定，解除 'close' 的 pending 闸门。
		this.handshakeFailurePending = false;

		// 尝试解析业务错误 JSON（gateway 包装：{success:false,code:406,msg:"token已过期"}）。
		// Note: 用具名类型而非 `as typeof biz` —— 后者会被控制流分析窄化成 `null`。
		type BizError = { success?: unknown; code?: unknown; msg?: unknown };
		let biz: BizError | null = null;
		if (bodyComplete && bodyText) {
			try {
				const p = JSON.parse(bodyText);
				if (p && typeof p === 'object') biz = p as BizError;
			} catch {
				// 非 JSON body（如网关 rewarm 时的 HTML/纯文本）→ 落到 transient 分支
			}
		}
		// #184(b) P1:permanent 白名单。gateway WebFluxGlobalExceptionHandler 对一切异常
		// setStatusCode(OK)，且 handleResponseStatusException 把原始 HTTP 状态码当业务 code，
		// 导致启动空窗 503 被包成 200+{code:503}、默认异常 200+{code:-1}；旧宽判定
		// (success===false || code>=400) 把它们全熔断成永久离线（#152 复活）。现在只在身份真的
		// 失效的 code 上才 permanent，其余一律 transient 让 backoff 自愈。
		const PERMANENT_HTTP_STATUSES = new Set(['401', '403', '406']);
		const PERMANENT_BIZ_CODES = new Set([401, 403, 406, 40001, 100000004, 100000005]);
		const bodyBizCode = biz !== null && typeof biz.code === 'number' ? biz.code : null;
		const permanent =
			PERMANENT_HTTP_STATUSES.has(String(statusCode)) ||
			(bodyBizCode !== null && PERMANENT_BIZ_CODES.has(bodyBizCode));

		if (permanent) {
			const bizCode = bodyBizCode !== null ? String(bodyBizCode) : '';
			const bizMsg = biz && typeof biz.msg === 'string' ? biz.msg : '';
			const bodySnip = bodyText.slice(0, 200);
			// manager 裁决：WARN 级以上上报，含身份 uid + http status + 业务 code + msg（静默 43 分钟的教训）。
			// #459 追加 stage/endpoint：恢复链路的每条日志都能定位到「哪个身份、打哪个端点、卡在哪一步」。
			console.warn(
				`[hula-ws] Permanent handshake failure uid=${uid} stage=handshake endpoint=${this.endpoint} http=${statusCode}` +
					(bizCode ? ` bizCode=${bizCode}` : '') +
					(bizMsg ? ` msg=${bizMsg}` : '') +
					(bodyText ? ` body=${bodySnip}` : '') +
					' — circuit broken, stopping reconnect',
			);
			this.closed = true;
			this.transientHandshakeCount = 0;
			if (this.reconnectTimer) {
				clearTimeout(this.reconnectTimer);
				this.reconnectTimer = null;
			}
			const stopEpoch = this.stopEpoch;
			if (this.options.onAuthError) {
				try {
					const canRetry = await this.options.onAuthError();
					// #459 onAuthError 期间实例可能已被 close() 停掉、或已经换了新代次——不得把
					// 已停止的实例拉回重连，也不得替新连接再排一个定时器。
					if (canRetry && this.stopEpoch === stopEpoch && this.ws === ws) {
						// 上层刷新了凭据 → 解除断路、回到 backoff 重连（保留旧 401+refresh 语义）。
						this.closed = false;
						this.scheduleReconnect();
					}
				} catch (e) {
					console.error('[hula-ws] onAuthError failed:', e);
				}
			}
			return;
		}

		// transient：非 JSON / 空 body / 默认异常 code=-1 / 网关瞬态 502/503（含被包成 200+{code:503}）等。
		// 计数++，达阈值告警，但不永久停——白名单外的 code 一律让 backoff 自愈。
		this.transientHandshakeCount += 1;
		const count = this.transientHandshakeCount;
		const threshold = HulaWSClient.TRANSIENT_HANDSHAKE_WARN_THRESHOLD;
		console.warn(
			`[hula-ws] uid=${uid} stage=handshake endpoint=${this.endpoint} http=${statusCode}` +
				` count=${count}/${threshold}` +
				(bodyText ? ` body=${bodyText.slice(0, 120)}` : ' body=<empty>') +
				' — transient handshake failure, will retry via backoff',
		);
		if (count >= threshold) {
			console.warn(
				`[hula-ws] uid=${uid} hit ${count} consecutive transient ws handshake failures — ` +
					'suspected gateway-side outage (still retrying, not permanent)',
			);
		}
		// #184(b) P2b:transient 路径显式通知 supervisor 离线——握手失败的 socket 已废，不能让
		// supervisor 在 backoff 窗口里仍认为该身份 online（虚报）。'close' 也会触发 onDisconnected，
		// supervisor 对重复调用需幂等。
		this.options.onDisconnected?.();
		// 依赖后续 'close'(1006) → scheduleReconnect backoff。若 'close' 已在 body 读取期间触发，
		// 它因 handshakeFailurePending 已 return，故此处兜底调度一次（scheduleReconnect 幂等）。
		this.scheduleReconnect();
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
		// #459 stop 代次：异步分类（等 body / 等 onAuthError）回来时据此判断「实例已被停掉」，
		// 不得把已停止的实例重新排上重连定时器。
		this.stopEpoch += 1;
		this.stopHeartbeat();
		this.stopWatchdog();
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.log('stopped', 'closed by caller — reconnect disabled');
		this.ws?.close();
	}

	get isConnected(): boolean {
		return this.ws?.readyState === WebSocket.OPEN;
	}

	private startHeartbeat(): void {
		// P1-3: idempotent — clear any existing timer so a double-start can never leak
		// an orphaned interval.
		this.stopHeartbeat();
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
		// P1-3: idempotent — clear any existing timer so a double-start can never leak
		// an orphaned interval.
		this.stopWatchdog();
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

	/**
	 * #459 恢复链路的统一日志：uid + stage + endpoint + 细节。
	 * 旧日志只有 '[hula-ws] Reconnecting in …' 之类的无归属行，多身份/多端点时无法判断是谁在恢复；
	 * 事故复盘（#152 静默 43 分钟）要求每条恢复日志都能归属到身份与阶段。
	 */
	private log(stage: string, detail?: string): void {
		console.log(
			`[hula-ws] uid=${this.options.uid ?? '?'} stage=${stage} endpoint=${this.endpoint}` +
				(detail ? ` ${detail}` : ''),
		);
	}

	private scheduleReconnect(): void {
		// #459 已停止的实例不得再排重连（close()/degrade 之后迟到的 close/分类事件会走到这里）。
		if (this.closed) return;
		// P1-4: only ONE reconnect pending at a time. Two 'close'/error events (or
		// error + close) could otherwise stack parallel reconnect timers.
		if (this.reconnectTimer) {
			return;
		}
		const delay = this.reconnectDelay;
		this.log('retrying', `in ${delay}ms`);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, delay);
		this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
	}
}
