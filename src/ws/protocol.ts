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
	| 'offline';

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
