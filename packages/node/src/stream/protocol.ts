/**
 * WS 请求类型（plugins → server）
 * 与 HuLa-Server WSReqTypeEnum 对应
 */
export enum WSReqType {
	HEARTBEAT = 2,
	ACK = 15,
	STREAM_START = 17,
	STREAM_DELTA = 18,
	STREAM_END = 19,
	// REQ-004: THINKING 协议
	THINKING_START = 20,
	THINKING_DELTA = 21, // 21: S4 起废弃，不再发送、不复用
	THINKING_END = 22,
	// REQ-010 S9: CC owner-launch bind RPC result (node → server, replies to a server `ccBindRequest`).
	CC_BIND_RESULT = 23,
}

/**
 * WS 响应类型（server → plugins）
 * 与 HuLa-Server WSRespTypeEnum 对应
 */
export type WSRespType =
	| 'receiveMessage'
	| 'streamStart'
	| 'streamDelta'
	| 'streamEnd'
	| 'aiclawAuthRequest'
	| 'tokenExpired'
	| 'online'
	| 'offline'
	// REQ-004: THINKING 协议 + 群配置更新
	| 'thinkingStart'
	| 'thinkingEnd'
	| 'groupConfigChange'
	// REQ-010 S9: server asks node to compute the CC owner-launch command for a (room, identity).
	| 'ccBindRequest';

/**
 * WS 请求消息格式
 */
export interface WSRequest {
	type: number;
	data: string; // JSON string
}

/**
 * WS 响应消息格式
 */
export interface WSResponse<T = unknown> {
	type: WSRespType;
	data: T;
}

/**
 * 文本消息 body（message.type=1）。
 */
export interface TextMessageBody {
	content: string;
	urlContentMap?: Record<string, unknown>;
	/**
	 * REQ-004 S5: @ 的 uid 列表（Java List<Long>，序列化为 string/number 数组）。
	 * 元素 0 = @所有人/@all；显式 @ 机器人时含 selfUid。
	 */
	atUidList?: Array<string | number>;
	reply?: unknown;
}

/**
 * REQ-007 #73: 媒体消息 body（message.type=3=IMG / 4=FILE）。
 * `url` 为可直接 GET 的预签名地址；FILE 必带 `fileName`，IMG 可能缺省。
 * `content` 为可选文字附言（媒体随附文本）。
 */
export interface MediaMessageBody {
	url: string;
	size: number;
	mime?: string;
	fileName?: string;
	width?: number;
	height?: number;
	content?: string;
	atUidList?: Array<string | number>;
	reply?: unknown;
}

/**
 * receiveMessage body 联合体。**外部判别**：由 `message.type` 决定具体形状
 * （1=文本 → TextMessageBody；3=IMG / 4=FILE → MediaMessageBody），
 * 而非 body 自身的判别字段。运行期可用 {@link isMediaMessageBody} 收窄。
 */
export type ReceivedMessageBody = TextMessageBody | MediaMessageBody;

/** 运行期收窄：body 是否为媒体 body（以 `url` 字段存在为判据）。 */
export function isMediaMessageBody(b: ReceivedMessageBody): b is MediaMessageBody {
	return 'url' in b;
}

/**
 * 收到的 IM 消息结构（receiveMessage 中的 data）
 */
export interface ReceivedMessage {
	fromUser: {
		uid: string | number; // Java Long 序列化为字符串
		name?: string;
		avatar?: string;
		userType?: number;
	};
	message: {
		id: string | number;
		roomId: string | number;
		type: number;
		/** REQ-004 S5: 会话类型（server 下发）。1=GROUP，2=FRIEND（1:1 私聊）。缺省视为群聊（保守）。 */
		roomType?: number;
		sendTime: string;
		/**
		 * 消息体。判别由 `message.type` 决定（1=文本 TextMessageBody，
		 * 3=IMG / 4=FILE MediaMessageBody）。
		 */
		body: ReceivedMessageBody;
		/**
		 * REQ-008 #77: aiclaw 扩展信息，server 仅在推送给 aiclaw 用户时附加（私聊带；群聊缺省）。
		 * `isOwner` = 发送者是否为本 aiclaw 的主人（server 算 senderUid==ownerUid）。
		 */
		aiclaw?: {
			isOwner?: boolean;
		};
	};
}

// ─── REQ-004: THINKING Payload 类型 ───

/** plugin → server: THINKING_START (20) */
export interface ThinkingStartPayload {
	fromUid: string | number;
	roomId: string | number;
	triggerMsgId: string;
}

/** plugin → server: THINKING_END (22) */
export interface ThinkingEndPayload {
	thinkingId?: string;
	durationMs: number;
	status: 'complete' | 'error';
	error?: string;
	roomId?: string | number;
	/** REQ-004 S4: 完整累计的 thinking 文本（替代逐帧 THINKING_DELTA） */
	content: string;
	/**
	 * REQ-004 S3: 本轮以 skip 终结时的原因（显式 hula_skip_reply 的 reason，
	 * 或 agent 未调用任何终结动作工具时的兜底 'agent_no_terminal_tool'）。
	 * 以 send 终结时不带此字段；附加字段，不破坏既有 status/thinkingId/durationMs。
	 */
	skipReason?: string;
}

/** server → client: thinkingStart 广播 */
export interface ThinkingStartDTO {
	fromUid: string | number;
	roomId: string | number;
	triggerMsgId: string;
	thinkingId: string;
}

/** server → client: thinkingEnd 广播 */
export interface ThinkingEndDTO {
	fromUid: string | number;
	roomId: string | number;
	durationMs: number;
	status: 'complete' | 'error';
	error?: string;
	/** server 生成的 thinking 记录 ID（有 thinkingId 时为群广播，无时为直接拒绝） */
	thinkingId?: string;
}

/** server → client/plugin: 群配置变更通知 */
export interface GroupConfigChangeDTO {
	// REQ-029 (#29): server serializes Long as string; handler String()-normalizes at ingress.
	aiclawUid: string | number;
	roomId: string | number;
	/** REQ-009 #85: the group's human-readable group number ("groupkey"), carried on the outer message. */
	account?: string;
	config: {
		rateLimitPerMinute: number;
		mentionRequired: boolean;
		dailyLimit: number;
		respondToAi: boolean;
		/** REQ-009 #85: owner-configured absolute host workspace path (empty/absent → derive default). */
		workspaceDir?: string;
	};
}

/**
 * REQ-010 S9: server → node `ccBindRequest` body. The server routes a CC owner-launch request
 * (surfaced from the HuLa client) only to cc aiclaws; node generates the launch command via
 * `CcDriver.bind()` and replies `CC_BIND_RESULT` keyed by `requestId`.
 * roomType: 1=GROUP, 2=FRIEND/DM; counterpartUid present for DMs (the other party).
 */
export interface CcBindRequestDTO {
	// REQ-029 (#29): server serializes Long as string; handler String()-normalizes at ingress.
	roomId: string | number;
	roomType: number;
	counterpartUid?: string | number;
	requestId: string;
}

/**
 * 构建 WS 请求
 */
export function buildRequest(type: WSReqType, data: Record<string, unknown>): string {
	const req: WSRequest = {
		type,
		data: JSON.stringify(data),
	};
	return JSON.stringify(req);
}
