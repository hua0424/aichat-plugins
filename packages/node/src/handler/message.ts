import type { WSResponse, ReceivedMessage, ThinkingStartDTO, ThinkingEndDTO, GroupConfigChangeDTO, AiclawPersonaChangeDTO } from '../stream/protocol.js';
import type { HulaWSClient } from '../server/hula-ws.js';
import { WSReqType } from '../stream/protocol.js';
import type { AgentDriver, AgentSession, AgentEvent } from '../agent/events.js';
import { reduceThinking } from '../agent/thinking-map.js';
import { bindingKey } from '../agent/bind-token-store.js';
import { MessageDebouncer } from '../util/debounce.js';
import { AntiLoopGuard } from './anti-loop.js';
import { GroupConfigCache } from './group-config-cache.js';
import type { HulaApiClient } from '../api/hula-api.js';
import { buildAgentInjection } from './media-inject.js';
import { buildAgentEnvelope } from './envelope.js';
import type { AgentPromptTemplates } from '../agent/prompt-templates.js';
import { errMsg } from '../util/err.js';

/**
 * REQ-004 S4: THINKING_END content 帧安全上限（字节）。
 * 256 KiB，**严格高于** server 的 200 KB 截断阈值——这是有意的：
 * server 是唯一的截断权威，仅当收到 content > 200KB 时才截断并置 status=4。
 * 若插件在此处也卡在 200KB，server 永远收不到 >200KB，status=4 会被短路。
 * 本上限只保证 WS 帧不溢出传输层；200KB~256KB 之间的内容仍原样送到 server，
 * 由 server 截断到 200KB 并标记 status=4。
 */
const THINKING_END_MAX_BYTES = 256 * 1024;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });

/**
 * 将字符串截断到至多 maxBytes 个 UTF-8 字节，且不切断多字节字符。
 * 仅用于 THINKING_END 的帧安全；server 仍是唯一截断权威。
 *
 * 注意：不能直接 decode(slice(0, maxBytes))——TextDecoder(fatal:false) 会把尾部
 * 残缺的多字节序列替换成 U+FFFD（3 字节），反而可能让结果 re-encode 后超出 maxBytes。
 * 因此先把切点回退到合法的 UTF-8 字符边界（continuation byte 0b10xxxxxx 之前），
 * 再 decode，保证输出字节数 <= maxBytes 且无乱码。
 */
function capUtf8Bytes(text: string, maxBytes: number = THINKING_END_MAX_BYTES): string {
	const encoded = TEXT_ENCODER.encode(text);
	if (encoded.length <= maxBytes) return text;
	// 从 maxBytes 处向前回退，跳过 UTF-8 续字节（高位 0b10xxxxxx）到字符起始边界
	let end = maxBytes;
	while (end > 0 && (encoded[end] & 0b1100_0000) === 0b1000_0000) {
		end--;
	}
	return TEXT_DECODER.decode(encoded.subarray(0, end));
}

/**
 * REQ-146 (#146): mask `url:` lines so short-lived signed download URLs never reach node logs.
 * Matches a line-leading `url: <value>` (the file-attachment block's url line) and replaces the value.
 * Used only at log sites; the un-redacted text still flows to the agent driver.
 */
function redactUrls(text: string): string {
	// #146 review P1：用 `.+`（而非 `\S+`）吃到行尾——防御 url 内含空格/被截断也整行遮蔽。
	return text.replace(/^(\s*url:\s*).+$/gm, '$1<redacted>');
}

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
	/** REQ-004 S4: 思考内容累计，THINKING_END 一次性整发 */
	accumulatedContent: string;
	/** 超时清理定时器 ID */
	timeoutId?: ReturnType<typeof setTimeout>;
	/** 是否已 finalized（防止 onThinkingEnd / handleThinkingEndBroadcast 双重清理） */
	finalized: boolean;
	/**
	 * REQ-008 #75: 本轮 agent 事件全序列，done 时交给 reduceThinking 结算。
	 * accumulatedContent 仍同步维护（超时/广播 partial 帧用），events 仅在 clean done 时归约。
	 */
	events: AgentEvent[];
	/** REQ-008 #75: 当前轮的 driver session，超时/广播 finalize 时 best-effort close。 */
	agentSession?: AgentSession;
}

/**
 * 最近一次收到的用户消息上下文
 */
interface LastMessageContext {
	// REQ-029 (#29): roomId/fromUid are opaque strings (>2^53-safe).
	roomId: string;
	fromUid: string;
	/**
	 * REQ-011 S3: 发言者显示名（取自 inbound 的 fromUser.name，缺省 'unknown'）。
	 * cc channel 推送时用于对「当前消息」做发言者标注——CC 的反提示注入防御拒绝裸/指令式
	 * channel 文本，必须把消息呈现为「某人发的聊天消息」（`[name(uid)]: content`）才会被正常处理。
	 */
	fromName: string;
	msgId: string;
	/**
	 * REQ-008 #77: 触发消息的会话类型（1=GROUP，2=FRIEND/私聊）。缺省视为群聊（保守）。
	 * opencode driver 据此 + fromUid（私聊的对端）派生隔离的 workspace 目录。
	 */
	roomType: number;
	/**
	 * REQ-008 #77: 私聊对端是否为本 aiclaw 的主人（owner）。
	 * 取自 inbound 消息的 `message.aiclaw.isOwner`（server 算 senderUid==ownerUid，仅私聊推送带）。
	 * 主人私聊 → workspace/owner；非主人私聊 → workspace/<对端uid>。
	 */
	isOwner: boolean;
}

/**
 * REQ-004 S2: 单房间的处理状态。
 * debounce 队列 / 待处理消息 / 触发上下文均按房间隔离，杜绝跨房间污染。
 */
interface RoomChannel {
	debouncer: MessageDebouncer;
	pendingMessages: string[];
	lastCtx: LastMessageContext;
	/**
	 * REQ-004 S5: 群聊惰性积累缓冲。
	 * 未触发（未点名机器人）的群消息以 `[name(uid)]: content` 形式 FIFO 入此缓冲，
	 * 上限 50，超出 shift 最旧；下次真正触发时一次性注入 session 再清空。
	 */
	accumulatedMessages: string[];
	/**
	 * REQ-004 S8-7（issue #22）: 本轮触发 BATCH 的防循环标志。
	 * 守卫已从 handleReceiveMessage 移到 triggerAgentLoop 唯一汇聚点——
	 * 思考期间排队的消息经 flushPendingMessages 直推 debouncer 时也必经守卫。
	 * 每条 trigger-eligible 消息（无论是否随即入队）都更新这两个标志：
	 *   - batchSawHuman：本批是否出现过人类消息（出现则本轮按人类轮处理，计数归零）
	 *   - batchAiFromUid：本批最近一条对端 AI 消息的 fromUid（''=本批无对端 AI 消息）
	 * 守卫在 triggerAgentLoop 评估完本批后清零这两个标志（非 skipGuard 路径）。
	 * REQ-029 (#29): fromUid 为不透明字符串，无 AI 哨兵值改用 ''（原为 0）。
	 */
	batchSawHuman: boolean;
	batchAiFromUid: string;
	/**
	 * REQ-004 S8-7: 指数退避窗口标志。
	 * 守卫判定 delay 时置 true，rescheduled 触发落地时置 false。
	 * 为 true 期间，新到的 trigger-eligible 消息须入 pendingMessages（不另起触发），
	 * 在 rescheduled 轮的思考结束后随 flush 处理——退避窗口内不丢消息。
	 */
	antiLoopDelaying: boolean;
}

/** REQ-004 S5: 群聊惰性积累缓冲上限（FIFO） */
const ACCUMULATED_MESSAGES_CAP = 50;

/**
 * M4: server 限流拒绝（error code）→ autoReply 文案。单源，rate/daily 两条广播路径共用。
 * error code 不在此表 = 非限流错误（no autoReply）。
 */
const LIMIT_REASONS: Record<string, string> = {
	rate_limit_exceeded: '发言频率限制，已自动跳过本次响应',
	daily_limit_exceeded: '今日发言上限已达，已自动跳过本次响应',
};

/**
 * 消息处理器（REQ-004 Agent Loop 模型）
 * 接收用户消息 → ACK → 去重 → 触发 agent loop → THINKING 流式输出
 */
export class MessageHandler {
	private ws: HulaWSClient;
	private driver: AgentDriver;
	// REQ-029 (#29): selfUid is an opaque string end-to-end.
	private selfUid: string;

	// REQ-004: 替换 streaming boolean 为 thinkingSessions Map
	private thinkingSessions = new Map<string, ThinkingSession>();

	// REQ-004 S2: 按房间隔离的处理状态（debouncer / pendingMessages / lastCtx）；REQ-029: key 为字符串 roomId
	private roomChannels = new Map<string, RoomChannel>();

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

	// #132: this aiclaw's own display name, resolved once + cached, for the cc system-prompt identity anchor.
	private selfName: string | undefined;

	/**
	 * #188: 本 aiclaw 的人设缓存（owner 配置的 publicPersona）。唯一写入点：prewarmPersona（连接/重连
	 * 预热，正确性基础）与 handleAiclawPersonaChange（server 失效帧重拉，低延迟优化）。null = 无人设。
	 * REQ-018: 人设不再注入 envelope —— 经 openSession chatContext.persona 进各 driver 的 system 层。
	 */
	private persona: string | null = null;

	/**
	 * REQ-018: 本 aiclaw 的 agent prompt 模板缓存（身份锚 + 人设段 + 回复契约的原稿，server 下发）。
	 * 播种点：supervisor buildAgent fail-fast 拉取后经 setPromptTemplates 注入（上线前必有，缺失即不上线）；
	 * 刷新点：onConnected 的 prewarmPromptTemplates（首连 + 每次重连，与 prewarmPersona 同点）。
	 * null = 未拉取/拉取失败 → chatContext.templates 为 undefined → driver 不渲染 system 层（降级）。
	 */
	private templates: AgentPromptTemplates | null = null;

	/** debounce 配置（可注入，便于测试） */
	private readonly debounceOptions?: { waitMs?: number; maxCount?: number; maxWaitMs?: number };

	/**
	 * REQ-008 #76: token 过期回调。多身份监督器注入此回调以「降级单个身份」而非退整个进程。
	 * 必填（aichatoverview#163 删除单身份路径后，每个身份链路都由监督器注入降级回调）。
	 */
	private readonly onTokenExpired: () => void;

	constructor(
		ws: HulaWSClient,
		driver: AgentDriver,
		selfUid: string,
		apiClient: HulaApiClient | undefined,
		debounceOptions: { waitMs?: number; maxCount?: number; maxWaitMs?: number } | undefined,
		onTokenExpired: () => void,
	) {
		this.ws = ws;
		this.driver = driver;
		this.selfUid = selfUid;
		this.antiLoopGuard = new AntiLoopGuard();
		this.groupConfigCache = new GroupConfigCache();
		this.apiClient = apiClient || null;
		this.debounceOptions = debounceOptions;
		this.onTokenExpired = onTokenExpired;
	}

	/**
	 * REQ-018: this aiclaw's own display name, resolved once + cached, feeding the system-prompt
	 * identity anchor of ALL FOUR drivers (opencode/codex/openclaw/cc). A driver calls it (via
	 * chatContext.getSelfName) only when templates are present, so turns without templates pay nothing.
	 * The model needs to know it IS <name> to recognize @<name> in group chat as itself.
	 */
	private async resolveSelfName(): Promise<string | undefined> {
		if (this.selfName !== undefined) return this.selfName;
		if (!this.apiClient) return undefined;
		try {
			const p = await this.apiClient.getMemberInfo(this.selfUid);
			const name = (p.name ?? p.nickName ?? p.account) as string | undefined;
			if (name) this.selfName = name;
			return this.selfName;
		} catch {
			return undefined;
		}
	}

	/**
	 * 单点发送 THINKING_END：thinkingId 兜底 + 帧安全截断（capUtf8Bytes 256KB，server 仍是唯一截断权威）。
	 * 三条 finalize 路径（timeout/complete/error）共用，帧结构一处维护。error 缺省时不带该字段。
	 */
	private sendThinkingEnd(
		session: ThinkingSession,
		frame: { durationMs: number | undefined; status: 'complete' | 'error'; error?: string; content: string },
	): void {
		this.ws.send(WSReqType.THINKING_END, {
			thinkingId: session.thinkingId || undefined,
			durationMs: frame.durationMs,
			status: frame.status,
			...(frame.error !== undefined ? { error: frame.error } : {}),
			content: capUtf8Bytes(frame.content),
		});
	}

	/**
	 * 会话收尾（所有终结路径共用）：可选 best-effort 关闭 driver session（唤醒仍 park 的 for-await）、
	 * 从 thinkingSessions 删除、flush 待发消息。clean-complete/error 路径不关（迭代器已自然结束）→ closeDriver=false。
	 */
	private teardownSession(session: ThinkingSession, roomId: string, closeDriver: boolean): void {
		if (closeDriver) void session.agentSession?.close();
		this.thinkingSessions.delete(session.sessionKey);
		this.flushPendingMessages(roomId);
	}

	/**
	 * REQ-146 (#146): resolve a SHORT-lived signed download URL for a media message so the agent can
	 * access the file (server stopped emitting the old 7-day body.url). Returns the signed url on success;
	 * on no apiClient / signDownload failure returns undefined, letting buildAgentInjection fall back to
	 * body.url (old pre-deploy messages) or skip the attachment. Never crashes the message loop.
	 *
	 * IMPORTANT: never logs the URL. On failure it logs only msgId/roomId + a non-URL error string
	 * (signDownload's thrown message carries the HTTP status/server msg, not the signed url).
	 */
	private async resolveDownloadUrl(message: ReceivedMessage['message']): Promise<string | undefined> {
		if (!this.apiClient) return undefined;
		try {
			const { url } = await this.apiClient.signDownload(message.id);
			if (!url?.trim()) {
				// #146: 服务端 200 但 data.url 空——补观测（曾静默返回 undefined→媒体消息被跳）。不打 url 明文。
				console.warn(`[media] signDownload msgId=${String(message.id)} returned empty url (server ok, no data.url)`);
				return undefined;
			}
			return url;
		} catch (err) {
			console.warn(
				`[media] signDownload failed msgId=${String(message.id)} roomId=${String(message.roomId)}; falling back to embedded url if present: ${errMsg(err)}`,
			);
			return undefined;
		}
	}

	/**
	 * REQ-004 S2: 获取/创建指定房间的处理通道。
	 * 每个房间有独立的 debouncer，flush 时只触发该房间的 agent loop。
	 */
	private getRoomChannel(roomId: string): RoomChannel {
		let channel = this.roomChannels.get(roomId);
		if (!channel) {
			const debouncer = new MessageDebouncer((merged) => {
				this.triggerAgentLoop(roomId, merged).catch((err) => {
					console.error(`[handler] triggerAgentLoop unhandled error (room ${roomId}):`, err.message);
				});
			}, this.debounceOptions);
			channel = {
				debouncer,
				pendingMessages: [],
				lastCtx: { roomId, fromUid: '', fromName: 'unknown', msgId: '', roomType: 1, isOwner: false },
				accumulatedMessages: [],
				batchSawHuman: false,
				batchAiFromUid: '',
				antiLoopDelaying: false,
			};
			this.roomChannels.set(roomId, channel);
		}
		return channel;
	}

	handle(msg: WSResponse): void {
		switch (msg.type) {
			case 'receiveMessage':
				// REQ-146: media messages now resolve a short-lived signed URL (async) before injection,
				// so handleReceiveMessage is async. ACK/dedup run in its synchronous prefix (before any await),
				// so they still fire promptly; we don't await here (fire-and-forget, mirroring prior behavior).
				this.handleReceiveMessage(msg.data as ReceivedMessage).catch((err) => {
					console.error('[handler] handleReceiveMessage error:', errMsg(err));
				});
				break;
			case 'thinkingStart':
				this.handleThinkingStartBroadcast(msg.data as ThinkingStartDTO);
				break;
			case 'groupConfigChange':
				this.handleGroupConfigChange(msg.data as GroupConfigChangeDTO);
				break;
			case 'aiclawPersonaChanged':
				// #188: fire-and-forget（对齐 receiveMessage 的异步调用风格）——重拉是低延迟优化，
				// 失败只 console.warn 保留旧缓存，绝不让一帧失效通知打断 WS 帧循环。
				this.handleAiclawPersonaChange(msg.data as AiclawPersonaChangeDTO).catch((err) => {
					console.error('[handler] handleAiclawPersonaChange error:', errMsg(err));
				});
				break;
			case 'thinkingEnd':
				this.handleThinkingEndBroadcast(msg.data as ThinkingEndDTO);
				break;
			case 'tokenExpired':
				// REQ-008 #76: 降级本身份（不退整个进程）。回调必填——监督器为每条身份链路注入。
				console.error('[handler] Token expired, degrading this identity...');
				this.onTokenExpired();
				break;
			case 'aiclawAuthRequest':
				console.warn('[handler] Machine code auth request received. Waiting for owner approval...');
				break;
			default:
				break;
		}
	}

	private async handleReceiveMessage(data: ReceivedMessage): Promise<void> {
		const msgId = String(data.message.id);

		// 1. 发送 ACK（REQ-029 #29: msgId 作为不透明字符串发送，绝不 Number()——>2^53 会精度丢失）
		this.ws.send(WSReqType.ACK, {
			msgId,
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
		// REQ-007 #73: 文本(1)直接用；图片(3)/文件(4)注入 file-attachment；其余类型跳过。
		// REQ-146 (#146): server 已停发 7 天下载地址——图片(3)/文件(4)落地时先 async 换取一个短效签名地址
		// （signDownload），把它作为 resolvedFileUrl 注入本轮 agent 输入；文本(1)不触发任何网络调用（同步路径不变）。
		const mediaType = data.message.type;
		const resolvedFileUrl =
			mediaType === 3 || mediaType === 4 ? await this.resolveDownloadUrl(data.message) : undefined;
		const content = buildAgentInjection(data.message, resolvedFileUrl);
		if (!content?.trim()) {
			// #146: 空注入即跳过——补一行观测（曾是静默黑洞，导致 objectKey-only 文件消息无声丢失）。
			// 只打类型/长度/布尔，绝不打 url 明文。
			if (mediaType === 3 || mediaType === 4) {
				const bodyUrlBlank = !((data.message.body as { url?: string })?.url?.trim());
				console.log(
					`[handler] media msgId=${msgId} type=${mediaType} skipped: empty injection (signedUrlLen=${resolvedFileUrl?.length ?? 0}, bodyUrlBlank=${bodyUrlBlank})`,
				);
			}
			return;
		}

		// REQ-029 (#29): normalize inbound ids with String(...) (NOT Number()) — opaque strings end-to-end.
		const roomId = String(data.message.roomId);
		const fromUid = String(data.fromUser.uid);
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

		const channel = this.getRoomChannel(roomId);

		// 5.5. 【S5】@ 触发闸门 + 惰性积累
		//   私聊（roomType=2）始终触发；群聊默认需点名（mention_required），缺省/未知 roomType 视为群聊（保守）。
		//   未触发的群消息以 `[name(uid)]: content` 入积累缓冲，**不**入 pendingMessages、**不**触发；
		//   下次触发时由 triggerAgentLoop 一次性注入。
		//   注意：此判定必须在「thinking 活跃入队」(step 6) 之前——否则未点名消息会被错误地排入 pendingMessages 并在本轮思考结束后误触发。
		const roomType = data.message.roomType;
		const isPrivate = roomType === 2;
		// 私聊始终触发；群聊：mentionRequired（缺省 true，与 server 新默认对齐）关闭时全触发，开启时仅显式
		// @ 机器人（atUidList 含 selfUid）才算点名——0=@所有人 不算点名（裁决）。短路求值：私聊不读群配置/atUid。
		const triggerEligible =
			isPrivate ||
			!(this.groupConfigCache.get(this.selfUid, roomId)?.mentionRequired ?? true) ||
			(data.message.body?.atUidList ?? []).map(String).includes(String(this.selfUid));

		if (!triggerEligible) {
			// 惰性积累：标注发言者，FIFO 上限 50。@所有人 落在此处（不触发但仍积累）。
			const name = data.fromUser.name ?? 'unknown';
			channel.accumulatedMessages.push(`[${name}(${fromUid})]: ${content}`);
			if (channel.accumulatedMessages.length > ACCUMULATED_MESSAGES_CAP) {
				channel.accumulatedMessages.shift();
			}
			console.log(`[handler] Message accumulated (not mentioned) room=${roomId}, buffer: ${channel.accumulatedMessages.length}`);
			return;
		}

		// 缓存消息上下文（按房间隔离）。REQ-008 #77: roomType 透传给 driver 的 chatContext，
		// 缺省/未知 roomType 与上方 @ 闸门一致按群聊（1）保守处理。
		// isOwner 取自 inbound 的 message.aiclaw.isOwner（仅私聊推送带 aiclaw ext；群聊缺省 false）。
		const isOwner = data.message.aiclaw?.isOwner === true;
		// REQ-011 S3: cache the sender display name so the cc channel push can attribute the current message.
		const fromName = data.fromUser.name ?? 'unknown';
		channel.lastCtx = { roomId, fromUid, fromName, msgId, roomType: roomType ?? 1, isOwner };

		// REQ-146: redact any `url:` line before previewing — media injections now embed a short-lived
		// signed download URL that must NEVER reach node logs.
		console.log(`[handler] Message from ${data.fromUser.name ?? 'unknown'}(${data.fromUser.uid}) in room ${roomId}: ${redactUrls(content).substring(0, 50)}...`);

		// 5.6. 【S8-7 issue #22】更新本轮触发 BATCH 的防循环标志。
		//   必须在「思考活跃/退避入队」(step 6) 之前——无论该消息随即入队还是直接 debounce，
		//   它都属于「下一次 triggerAgentLoop 的本批」，守卫在汇聚点统一评估整批。
		//   人类消息一旦出现即标记 batchSawHuman（本轮按人类轮处理，反影子化）；
		//   对端 AI 消息记录其 fromUid（self 已在 step 3 早返回，这里 isFromAi 必是对端）。
		if (isFromAi) {
			channel.batchAiFromUid = fromUid;
		} else {
			channel.batchSawHuman = true;
		}

		const sessionKey = bindingKey(this.selfUid, roomId);

		// 6. thinking 活跃 **或** 处于退避窗口时入队——退避窗口内不另起触发、不丢消息，
		//    待 rescheduled 触发的思考结束后随 flushPendingMessages 处理。
		if (this.thinkingSessions.has(sessionKey) || channel.antiLoopDelaying) {
			channel.pendingMessages.push(content);
			console.log(`[handler] Message queued (thinking active or anti-loop delaying) room=${roomId}, pending: ${channel.pendingMessages.length}`);
			return;
		}

		// 7. 正常触发（防循环守卫已移至 triggerAgentLoop 唯一汇聚点，按 BATCH 评估）
		channel.debouncer.push(content);
	}

	/**
	 * REQ-004 Agent Loop 触发汇聚点。
	 * 所有触发路径（直达 debounce / pendingMessages flush / 退避 reschedule）都经此进入，
	 * 因此防循环守卫在此处按本轮 BATCH 统一评估，杜绝排队消息绕过守卫（issue #22）。
	 * @param skipGuard 退避 reschedule 调用时为 true：本轮守卫已评估过，不再重复评估/退避。
	 */
	private async triggerAgentLoop(roomId: string, message: string, skipGuard = false): Promise<void> {
		if (!this.ws.isConnected) {
			console.warn('[handler] WS not connected, dropping AI request');
			return;
		}

		const channel = this.roomChannels.get(roomId);
		if (!channel || !channel.lastCtx.msgId) {
			console.warn(`[handler] No message context for room ${roomId}, dropping AI request`);
			return;
		}

		const { msgId, roomType, fromUid, isOwner } = channel.lastCtx;
		const sessionKey = bindingKey(this.selfUid, roomId);

		// 【S8-7 issue #22】防循环守卫：在汇聚点按本轮 BATCH 评估，先于创建 thinking / 发 THINKING_START。
		//   - skipGuard=true（退避 reschedule 落地）跳过：本轮已评估过，不重复评估。
		//   - 本批仅当「无人类消息 且 出现过对端 AI 消息」才算一轮 AI-to-AI（反影子化：人类消息一票否决）。
		if (!skipGuard) {
			const isFromAi = !channel.batchSawHuman && channel.batchAiFromUid !== '';
			const fromUid = channel.batchAiFromUid;
			const guardResult = this.antiLoopGuard.check({
				roomId,
				fromUid,
				selfUid: this.selfUid,
				content: message,
				isFromAi,
			});
			// 评估完即清零本批标志（下一批重新积累）
			channel.batchSawHuman = false;
			channel.batchAiFromUid = '';

			if (guardResult.action === 'block') {
				console.log(`[anti-loop] block roomId=${roomId} reason=${guardResult.reason}`);
				this.sendAutoReply(roomId, guardResult.reason ?? 'rate limited');
				return;
			}

			if (guardResult.action === 'delay') {
				console.log(`[anti-loop] delay roomId=${roomId} delayMs=${guardResult.delayMs} aiRoundCount=${this.antiLoopGuard.getAiRoundCount(roomId)}`);
				channel.antiLoopDelaying = true;
				// 退避结束后**有意**重跑本次捕获的同一条 message：backoff 回答的就是触发它的那条消息。
				// 退避窗口期间排队的消息不在此处合并，而是随 rescheduled 轮思考结束后的 flush 处理（下一轮），
				// 不会丢失——这与 triggerAgentLoop 以 channel.lastCtx 为触发键的设计一致。
				setTimeout(() => {
					const ch = this.roomChannels.get(roomId);
					if (ch) ch.antiLoopDelaying = false;
					// 退避窗口结束：rescheduled 触发不再重复评估守卫（skipGuard=true）
					this.triggerAgentLoop(roomId, message, true).catch((err) => {
						console.error(`[handler] triggerAgentLoop (anti-loop reschedule) unhandled error (room ${roomId}):`, err.message);
					});
				}, guardResult.delayMs);
				return;
			}
			// 'allow'：继续
		}

		// 并发防护：必须先于「消费/清空积累缓冲」——只有真正进入交付路径时才消费缓冲，否则早返回会丢弃
		// 已清空但从未发送的群聊上下文（P1-a）。REQ-011 S2：cc 现为 node-driven，
		// 与 openclaw/opencode/codex 共用此标准守卫与 drop 语义（其消息内容不会因此丢失）。
		if (this.thinkingSessions.has(sessionKey)) {
			console.warn(`[handler] Thinking session already active for ${sessionKey}`);
			return;
		}

		// REQ-004 S5: 消费惰性积累的群聊上下文（自上次回复以来未点名的消息），随后清空缓冲。
		// 必须放在并发防护早返回之后——只有真正进入交付（thinking session）时才消费/清空缓冲，
		// 否则早返回会丢弃已清空但从未发送的群聊上下文。
		const accumulated = channel.accumulatedMessages;
		channel.accumulatedMessages = [];

		// REQ-013 S1: build the ONE unified inbound-attribution envelope for ALL FOUR drivers at this
		// common layer (see ./envelope.ts). openclaw/opencode/codex/cc all now receive the identical
		// `[HuLa 群聊]/[HuLa 私聊]\n[name(uid)]: ...` transcript instead of each inventing its own format.
		// REQ-018: buildAgentEnvelope is now PURE attributed text (room header + [name(uid)] lines).
		// The 人设 block is RETIRED from the per-turn message — persona + templates travel via
		// chatContext and each driver renders them into its SYSTEM layer at session open.
		const agentEnvelope = buildAgentEnvelope({
			roomType,
			fromName: channel.lastCtx.fromName,
			fromUid,
			accumulated,
			message,
		});

		// REQ-013 S1 / AC5: single observability point for the assembled envelope (BL-018-aligned). Log the
		// EXACT text handed to the driver — room header + `[name(uid)]` attribution — with newlines escaped
		// so it stays one grep-able line; capped at 300 chars to bound log volume. This is the only place the
		// four-driver envelope is emitted, so a log grep here is the structural evidence for AC1/AC5.
		// REQ-146: redact `url:` lines — the media file-attachment block now carries a short-lived signed
		// download URL, which must NEVER be printed. The real (un-redacted) envelope still goes to the driver.
		console.log(
			`[handler] envelope→driver(${this.driver.type}) room=${roomId} from=${channel.lastCtx.fromName}(${fromUid}) roomType=${roomType}: ${redactUrls(agentEnvelope).slice(0, 300).replace(/\n/g, '\\n')}`,
		);

		// 创建 thinking session（thinkingId 初始为空，等 server 广播回填）
		const session: ThinkingSession = {
			sessionKey,
			thinkingId: '',
			triggerMsgId: msgId,
			startTime: Date.now(),
			accumulatedContent: '',
			finalized: false,
			events: [],
		};

		// 设置 5 分钟超时定时器（P-M2-3）
		session.timeoutId = setTimeout(() => {
			if (session.finalized) return;
			session.finalized = true;
			console.error(`[thinking] timeout session=${sessionKey} after ${this.THINKING_SESSION_TIMEOUT_MS}ms`);
			this.sendThinkingEnd(session, {
				durationMs: Date.now() - session.startTime,
				status: 'error',
				error: 'thinking_session_timeout',
				content: session.accumulatedContent,
			});
			// REQ-008 #75: best-effort 收尾 driver session，让卡住的迭代器能终止。
			this.teardownSession(session, roomId, true);
		}, this.THINKING_SESSION_TIMEOUT_MS);

		this.thinkingSessions.set(sessionKey, session);

		console.log(`[thinking] start msgId=${msgId} sessionKey=${sessionKey}`);

		// 发送 THINKING_START
		this.ws.send(WSReqType.THINKING_START, {
			fromUid: this.selfUid,
			roomId,
			triggerMsgId: msgId,
		});

		// REQ-008 #75: 通过 AgentDriver 抽象消费规范化 AgentEvent 流，再映射成与既有
		// 完全一致的 WS 发送。openSession 绑定 (aiclawUid, roomId) → sessionKey；
		// session 存到 thinkingSession 上，供超时/广播/destroy finalize 时 best-effort close。
		// REQ-008 #77: 透传会话上下文给 driver。openclaw driver 忽略 chatContext（行为不变）；
		// opencode driver 据此派生隔离 workspace 目录。私聊（roomType=2）的对端 = fromUid。
		// REQ-009 #85: 群房间附带 owner 配置的 workspaceDir（绝对覆盖）+ account（人类可读 groupkey）。
		//   私聊无群配置 → 两者 undefined → driver 走默认派生。房间/身份只取自会话绑定，不取自事件。
		const cfg = this.groupConfigCache.get(this.selfUid, roomId);
		const agentSession = await this.driver.openSession({
			aiclawUid: this.selfUid,
			roomId,
			chatContext: {
				roomType,
				roomId,
				counterpartUid: fromUid,
				isOwner,
				workspaceDir: cfg?.workspaceDir,
				account: cfg?.account,
				// REQ-018: LAZY self-name resolver (cached), now feeding the system-prompt identity anchor of
				// ALL FOUR drivers (opencode/codex/openclaw/cc). Called only when templates are present.
				getSelfName: () => this.resolveSelfName(),
				// REQ-018: persona + templates ride in chatContext; each driver renders its system layer
				// from them. templates null (unprewarmed/failed) → undefined → driver degrades (no system prompt).
				persona: this.persona,
				templates: this.templates ?? undefined,
			},
		});
		session.agentSession = agentSession;

		// done 事件：clean finalize-complete，用 reduceThinking 归约整段事件序列，
		// 帧字节必须与既有 onThinkingEnd 完全一致。
		const finalizeComplete = () => {
			if (session.finalized) return;
			session.finalized = true;
			if (session.timeoutId) clearTimeout(session.timeoutId);
			const outcome = reduceThinking(session.events);
			// 可选 driver 钩子：openclaw 借此过滤自有的 NO_REPLY 哨兵及空/纯空白思考正文；其它 driver 无钩子 → 逐字节不变。
			const rawContent = this.driver.finalizeThinking?.(outcome.content) ?? outcome.content;
			this.sendThinkingEnd(session, { durationMs: outcome.durationMs, status: 'complete', content: rawContent });
			console.log(`[thinking] end session=${sessionKey} durationMs=${outcome.durationMs}`);
			// clean-complete：迭代器已自然结束，不再 close（closeDriver=false）。
			this.teardownSession(session, roomId, false);
		};

		// error 事件：与既有 onError 一致的 finalize-error 路径。
		const finalizeError = (message: string) => {
			if (session.finalized) return;
			session.finalized = true;
			if (session.timeoutId) clearTimeout(session.timeoutId);
			console.error(`[thinking] error session=${sessionKey} reason=${message}`);
			this.sendThinkingEnd(session, {
				durationMs: Date.now() - session.startTime,
				status: 'error',
				error: message,
				content: session.accumulatedContent,
			});
			this.teardownSession(session, roomId, false);
		};

		try {
			for await (const ev of agentSession.send(agentEnvelope)) {
				// 超时/广播 finalize 抢先：停止映射后续事件。session 的收尾交给 finally 统一 close。
				if (session.finalized) {
					break;
				}
				session.events.push(ev);
				if (ev.type === 'thinking') {
					// REQ-004 S4: 仅本地累计（超时/广播 partial 帧用），不再逐帧发 THINKING_DELTA。
					session.accumulatedContent += ev.text;
				} else if (ev.type === 'done') {
					finalizeComplete();
					break;
				} else if (ev.type === 'error') {
					finalizeError(ev.message);
					break;
				}
				// REQ-010 S1: the agent reply path via a terminal event is retired. The agent
				// replies out-of-band by running `aichat send-message` (the loopback capability),
				// so there is no per-event reply side-effect here. 'tool' events only feed
				// reduceThinking's accounting at done.
			}
		} catch (err) {
			finalizeError(errMsg(err));
		} finally {
			// REQ-008 #75 P2: 无论 done / error / break / throw，总在退出消费循环时收尾 driver session。
			// 与 Fix 1 配合：close() 唤醒仍 park 在 adapter 上的 for-await。幂等，安全多调。
			void agentSession.close();
		}
	}

	/** P-M2-2: 接收 server 的 thinkingStart 广播，回填 thinkingId */
	private handleThinkingStartBroadcast(data: ThinkingStartDTO): void {
		const { fromUid, roomId, triggerMsgId } = data;

		// 只处理自己发起的 thinking（server 广播给全员，通过 fromUid 过滤）
		if (String(fromUid) !== this.selfUid) return;

		// REQ-029 (#29): String(roomId) (drop Number()) — inbound roomId may be a >2^53 numeric string.
		const sessionKey = bindingKey(this.selfUid, String(roomId));
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

		// 回填 thinkingId（S4：仅用于 THINKING_END 携带，不再触发 delta flush）
		session.thinkingId = data.thinkingId || '';
		console.log(`[thinking] thinkingId backfilled: ${session.thinkingId} for ${sessionKey}`);
	}

	/**
	 * REQ #26: 启动连上 / 每次重连后主动拉一次本 aiclaw 的全部群配置预热内存 cache。
	 * 唯一其它填充点是 server 的 groupConfigChange 广播（仅 on-change），node 重启后
	 * cache 清空、自定义群配置会静默退默认；这里在 onConnected 时补一次全量拉取。
	 *
	 * 失败语义（BL-015 / #140）：**抛出**，交给调用方 retryAsync 做有界退避重试 + 失败日志。
	 * cache 仅在下方成功循环里写入 → 抛出时旧值天然保留。apiClient 为 null（未注入）时直接 noop。
	 */
	async prewarmGroupConfigs(): Promise<void> {
		if (!this.apiClient) return;
		const list = await this.apiClient.listSelfGroupConfigs();
		for (const item of list) {
			this.groupConfigCache.set(this.selfUid, item.roomId, {
				mentionRequired: Boolean(item.mentionRequired),
				respondToAi: Boolean(item.respondToAi),
				rateLimitPerMinute: item.rateLimitPerMinute ?? 0,
				dailyLimit: item.dailyLimit ?? 0,
				// REQ-009 #85: carry owner workspace override + groupkey through the cache.
				workspaceDir: item.workspaceDir,
				account: item.account,
			});
		}
		console.log(`[config] prewarmed ${list.length} group config(s) for aiclaw ${this.selfUid}`);
	}

	/**
	 * #188: 启动连上 / 每次重连后主动拉一次本 aiclaw 的人设预热内存缓存。语义对齐
	 * prewarmGroupConfigs（BL-015 / #140）：apiClient 为 null 时 noop；拉取失败**抛出**，
	 * 交给调用方 retryAsync 有界退避重试；persona 仅在成功返回后写入 → 抛出时旧值天然保留。
	 * server 端人设被清空（null/空白）时同样写入 null —— 重连即回到「无人设」基线，无需重激活。
	 */
	async prewarmPersona(): Promise<void> {
		if (!this.apiClient) return;
		const persona = await this.apiClient.getSelfPersona();
		this.persona = persona;
		console.log(`[persona] prewarmed for aiclaw ${this.selfUid}: ${persona === null ? '(none)' : `${persona.length} chars`}`);
	}

	/**
	 * REQ-018: supervisor buildAgent fail-fast 拉取到模板后注入缓存（上线前必有；拉取失败该身份根本不上线）。
	 * 之后每次 openSession 的 chatContext.templates 都从这里取值。此方法与 prewarmPromptTemplates 的差异：
	 * 这里直接赋值、不抛错（buildAgent 已保证值合法）。
	 */
	setPromptTemplates(templates: AgentPromptTemplates): void {
		this.templates = templates;
	}

	/**
	 * REQ-018: 启动连上 / 每次重连后主动拉一次 agent prompt 模板刷新内存缓存。语义对齐 prewarmPersona
	 * （BL-015 / #140）：apiClient 为 null 时 noop；拉取失败**抛出**，交给调用方 retryAsync 有界退避重试；
	 * templates 仅在成功返回后写入 → 抛出时旧值天然保留（与 supervisor 的 fail-fast 种子互补：种子保证上线
	 * 必有，这里是模板被 server 更新后重连追平）。
	 */
	async prewarmPromptTemplates(): Promise<void> {
		if (!this.apiClient) return;
		const t = await this.apiClient.getAgentPromptTemplates();
		this.templates = t;
		console.log(
			`[prompts] prewarmed for aiclaw ${this.selfUid}: identityAnchor=${t.identityAnchor.length} personaSection=${t.personaSection.length} replyContract=${t.replyContract.length}`,
		);
	}

	/**
	 * #188: server 的 aiclawPersonaChanged 失效帧 —— uid 匹配本身份则重拉人设刷新缓存。
	 * 语义与 handleGroupConfigChange 对齐（String() 归一后比对 uid，不匹配直接忽略）；
	 * 与 prewarm 的差异：这里失败**不抛**（帧处理 fire-and-forget），console.warn 保留旧缓存，
	 * 正确性由下次连接/重连的 prewarmPersona 兜底。
	 */
	private async handleAiclawPersonaChange(data: AiclawPersonaChangeDTO): Promise<void> {
		if (String(data.aiclawUid) !== this.selfUid) return;
		if (!this.apiClient) return;
		try {
			const persona = await this.apiClient.getSelfPersona();
			this.persona = persona;
			console.log(`[persona] refreshed after aiclawPersonaChanged for aiclaw ${this.selfUid}: ${persona === null ? '(none)' : `${persona.length} chars`}`);
		} catch (err) {
			console.warn(`[persona] refetch failed for aiclaw ${this.selfUid}, keeping old cache:`, errMsg(err));
		}
	}

	/** M3: 群配置变更通知处理 */
	private handleGroupConfigChange(data: GroupConfigChangeDTO): void {
		// REQ-029 (#29): compare/store ids as opaque strings (inbound may be numeric string or number).
		if (String(data.aiclawUid) !== this.selfUid) return;
		// REQ-009 #85: workspaceDir rides inside config; account rides on the outer message.
		this.groupConfigCache.set(this.selfUid, String(data.roomId), {
			...data.config,
			workspaceDir: data.config.workspaceDir,
			account: data.account,
		});
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
					const sessionKey = bindingKey(this.selfUid, String(roomId));
					const session = this.thinkingSessions.get(sessionKey);
					if (session) {
						if (session.timeoutId) clearTimeout(session.timeoutId);
						const reason = LIMIT_REASONS[error];
						console.log(`[thinking] server rejected: ${error} (no thinkingId fallback), sending autoReply roomId=${roomId}`);
						this.sendAutoReply(String(roomId), reason);
						// REQ-008 #75 P1-1②: best-effort 收尾 driver session（唤醒仍 park 的 for-await）。
						this.teardownSession(session, String(roomId), true);
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
			// REQ-008 #75 P1-1②: best-effort 收尾 driver session（唤醒仍 park 的 for-await）。
			this.teardownSession(session, String(roomId), true);
			return;
		}

		if (status === 'error' && error) {
			const reason = LIMIT_REASONS[error];
			if (reason) {
				console.log(`[thinking] server rejected: ${error}, sending autoReply roomId=${roomId}`);
				this.sendAutoReply(String(roomId), reason);
			} else {
				console.log(`[thinking] server error: ${error} (no autoReply)`);
			}
		}

		if (session) {
			session.finalized = true;
			// REQ-008 #75 P1-1②: best-effort 收尾 driver session（唤醒仍 park 的 for-await）。
			this.teardownSession(session, String(roomId), true);
		}
	}

	/** M3: 发送 autoReply（限流/退避触发时调用） */
	private sendAutoReply(roomId: string, reason: string): void {
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
				console.error('[anti-loop] autoReply failed:', errMsg(err));
			});
	}

	/** CR-S7: 清理所有 active session（进程退出时调用） */
	destroy(): void {
		for (const session of this.thinkingSessions.values()) {
			if (session.timeoutId) clearTimeout(session.timeoutId);
			// REQ-008 #75: best-effort 收尾 driver session（让卡住的迭代器终止）。
			void session.agentSession?.close();
			if (!session.finalized) {
				session.finalized = true;
				this.ws.send(WSReqType.THINKING_END, {
					thinkingId: session.thinkingId || undefined,
					durationMs: Date.now() - session.startTime,
					status: 'error',
					error: 'handler_destroyed',
					// 帧安全截断（256KB）；server 仍是唯一截断权威
					content: capUtf8Bytes(session.accumulatedContent),
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
	private flushPendingMessages(roomId: string): void {
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
	private maybeEvictRoom(roomId: string): void {
		const channel = this.roomChannels.get(roomId);
		if (!channel) return;
		const sessionKey = bindingKey(this.selfUid, roomId);
		if (
			channel.pendingMessages.length === 0 &&
			channel.debouncer.pending === 0 &&
			// REQ-004 S5: 仍持有未注入的群聊上下文时不回收，避免丢失积累上下文
			channel.accumulatedMessages.length === 0 &&
			!this.thinkingSessions.has(sessionKey)
		) {
			this.roomChannels.delete(roomId);
		}
	}
}
