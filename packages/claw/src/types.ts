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
	registerTool(tool: AgentTool): void;
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
	schema: Record<string, unknown>;
	execute(params: Record<string, unknown>): Promise<unknown>;
}
