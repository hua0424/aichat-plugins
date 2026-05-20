/**
 * Claw 适配器接口
 * 不同的 claw 后端（openclaw, zeroclaw 等）实现此接口即可接入
 */
export interface ClawAdapter {
	/** 适配器类型标识 */
	readonly type: string;

	/** 连接到 claw 后端 */
	connect(): Promise<void>;

	/** 断开连接 */
	disconnect(): Promise<void>;

	/**
	 * 发送消息并获取流式响应
	 * @param message 用户消息
	 * @param sessionKey 会话标识（格式：aiclaw-{uid}-room-{roomId}）
	 * @param callbacks 流式回调
	 */
	chat(message: string, sessionKey: string, callbacks: StreamCallbacks): Promise<void>;

	/** 当前是否已连接 */
	get isConnected(): boolean;
}

export interface StreamCallbacks {
	onChunk: (chunk: string) => void;
	onDone: (fullContent: string) => void;
	onError: (error: Error) => void;
}

/**
 * REQ-004: Thinking 流式回调（Agent Loop 模型）
 * 用于 THINKING_START/DELTA/END 协议（20/21/22）
 */
export interface ThinkingCallbacks {
	/** 收到 thinking delta */
	onThinkingDelta: (chunk: string) => void;
	/** thinking 结束，durationMs 为处理耗时 */
	onThinkingEnd: (durationMs: number) => void;
	/** 处理出错 */
	onError: (error: Error) => void;
}
