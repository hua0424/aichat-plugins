/**
 * AI 引擎抽象接口
 * 不同的 claw 实现此接口即可接入
 */
export interface AIEngine {
	/**
	 * 发送消息并获取流式响应
	 */
	chat(
		message: string,
		callbacks: StreamCallbacks,
	): Promise<void>;
}

export interface StreamCallbacks {
	onChunk: (chunk: string) => void;
	onDone: (fullContent: string) => void;
	onError: (error: Error) => void;
}
