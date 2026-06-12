/**
 * openclaw Plugin SDK 类型定义（精简版）
 * 仅声明 aichat-claw 实际使用的类型，避免依赖完整 openclaw 源码
 */

export interface PluginLogger {
	info(msg: string, ...args: unknown[]): void;
	warn(msg: string, ...args: unknown[]): void;
	error(msg: string, ...args: unknown[]): void;
	debug(msg: string, ...args: unknown[]): void;
}

export interface OpenClawPluginApi {
	logger: PluginLogger;
	runtime: PluginRuntime;
	registrationMode: 'full' | 'metadata-only';
	registerChannel(opts: { plugin: ChannelPlugin }): void;
	/**
	 * 注册 Agent Tool。
	 * - 直接传 AgentTool：静态注册（无会话上下文）。
	 * - 传 factory `(ctx) => AgentTool`：openclaw 在每次 agent run 前调用 factory，
	 *   ctx 提供本次会话的 sessionKey/sessionId/agentId（spike #2 实测），
	 *   闭包据此绑定 roomId 与发送身份到 execute。本地类型镜像补齐 factory 重载。
	 */
	registerTool(tool: AgentTool): void;
	registerTool(factory: (ctx: ToolContext) => AgentTool): void;
}

/**
 * Tool factory 上下文（openclaw 在 agent run 前注入）。
 * spike #2 实测：factory ctx 含 agentId / sessionKey / sessionId；
 * 不含 runId / channelId（openclaw 2026.6.5）。
 */
export interface ToolContext {
	/** 会话标识，格式 aiclaw-{uid}-room-{roomId}，openclaw 可能规范化为 agent:main:aiclaw-...；某些路径下可能缺失 */
	sessionKey?: string | null;
	/** openclaw 内部 sessionId（UUID） */
	sessionId?: string;
	/** agent 标识（如 main） */
	agentId?: string;
}

export interface PluginRuntime {
	config: Record<string, unknown>;
}

export interface ChannelPlugin {
	id: string;
	meta: ChannelMeta;
	capabilities: ChannelCapabilities;
	config: ChannelConfigAdapter;
	outbound?: ChannelOutboundAdapter;
}

export interface ChannelMeta {
	label: string;
	docs?: string;
	blurb?: string;
}

export interface ChannelCapabilities {
	chatTypes: ('direct' | 'group' | 'channel')[];
	polling?: boolean;
	reactions?: boolean;
	threads?: boolean;
	media?: boolean;
}

export interface ChannelConfigAdapter {
	listAccountIds(): string[];
	resolveAccount(accountId: string): ResolvedAccount | null;
}

export interface ResolvedAccount {
	accountId: string;
	name: string;
	enabled: boolean;
}

export interface ChannelOutboundAdapter {
	sendText(params: {
		accountId: string;
		to: string;
		text: string;
		threadId?: string;
	}): Promise<{ ok: boolean; error?: string }>;
}

export interface AgentTool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	execute(toolCallId: string, args: Record<string, unknown>): Promise<unknown>;
}
