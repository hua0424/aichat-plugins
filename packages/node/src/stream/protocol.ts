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
	THINKING_DELTA = 21,
	THINKING_END = 22,
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
	| 'thinkingDelta'
	| 'thinkingEnd'
	| 'groupConfigChange';

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
		sendTime: string;
		body: {
			content: string;
			urlContentMap?: Record<string, unknown>;
			atUidList?: unknown;
			reply?: unknown;
		};
	};
}

// ─── REQ-004: THINKING Payload 类型 ───

/** plugin → server: THINKING_START (20) */
export interface ThinkingStartPayload {
	fromUid: number;
	roomId: number;
	triggerMsgId: string;
}

/** plugin → server: THINKING_DELTA (21) */
export interface ThinkingDeltaPayload {
	thinkingId?: string;
	chunk: string;
	seq: number;
	roomId?: number;
}

/** plugin → server: THINKING_END (22) */
export interface ThinkingEndPayload {
	thinkingId?: string;
	durationMs: number;
	error?: string;
	roomId?: number;
}

/** server → client: thinkingStart 广播 */
export interface ThinkingStartDTO {
	fromUid: number;
	roomId: number;
	triggerMsgId: string;
	thinkingId: string;
}

/** server → client: thinkingDelta 广播 */
export interface ThinkingDeltaDTO {
	fromUid: number;
	roomId: number;
	chunk: string;
	seq: number;
}

/** server → client: thinkingEnd 广播 */
export interface ThinkingEndDTO {
	fromUid: number;
	roomId: number;
	durationMs: number;
	error?: string;
}

/** server → client/plugin: 群配置变更通知 */
export interface GroupConfigChangeDTO {
	aiclawUid: number;
	roomId: number;
	config: {
		rateLimitPerMinute: number;
		mentionRequired: boolean;
		dailyLimit: number;
		respondToAi: boolean;
	};
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
