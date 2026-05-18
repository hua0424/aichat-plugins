import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * ~/.aichat/ 目录
 */
export const AICHAT_HOME = resolve(process.env.AICHAT_HOME || join(homedir(), '.aichat'));

/**
 * 配置文件路径
 */
export const CONFIG_PATH = join(AICHAT_HOME, 'config.jsonc');
export const CREDENTIALS_PATH = join(AICHAT_HOME, 'credentials.jsonc');

/**
 * 用户配置（~/.aichat/config.jsonc，可选手动编辑）
 */
export interface AichatConfig {
	server?: {
		url?: string;       // WS 地址，默认由插件内置
	};
	openclaw?: {
		url?: string;       // Chat Completions API（旧版，向下兼容）
		token?: string;     // gateway token
		agentId?: string;
	};
	claws?: {
		openclaw?: {
			gatewayUrl?: string; // ws:// gateway 地址（新版）
			token?: string;
		};
	};
}

/**
 * 凭证（~/.aichat/credentials.jsonc，activate 后自动生成）
 */
export interface AichatCredentials {
	uid: number;
	connectionToken: string;
	machineCode: string;
	activatedAt: string;
}

/**
 * 默认服务器地址
 */
const DEFAULT_SERVER_URL = 'ws://localhost:18760/api/ws/ws';

/**
 * 加载配置
 */
export function loadConfig(): AichatConfig {
	if (!existsSync(CONFIG_PATH)) {
		return {};
	}
	try {
		const raw = readFileSync(CONFIG_PATH, 'utf-8');
		// 简易 JSONC 解析：去掉 // 注释行
		const json = raw.replace(/^\s*\/\/.*$/gm, '');
		return JSON.parse(json);
	} catch {
		return {};
	}
}

/**
 * 加载凭证
 */
export function loadCredentials(): AichatCredentials | null {
	if (!existsSync(CREDENTIALS_PATH)) {
		return null;
	}
	try {
		const raw = readFileSync(CREDENTIALS_PATH, 'utf-8');
		const json = raw.replace(/^\s*\/\/.*$/gm, '');
		return JSON.parse(json);
	} catch {
		return null;
	}
}

/**
 * 从本地 openclaw 安装目录读取 gateway auth token
 */
function readOpenclawGatewayToken(): string | null {
	const openclawConfigPath = resolve(homedir(), '.openclaw', 'openclaw.json');
	if (!existsSync(openclawConfigPath)) return null;
	try {
		const raw = readFileSync(openclawConfigPath, 'utf-8');
		const parsed = JSON.parse(raw);
		return parsed.gateway?.auth?.token || null;
	} catch {
		return null;
	}
}

/**
 * 获取完整运行配置
 */
export function getServerUrl(config: AichatConfig): string {
	return config.server?.url || DEFAULT_SERVER_URL;
}

/**
 * Claw 配置结果
 */
export interface ClawConfig {
	gatewayUrl: string;
	token: string;
}

/**
 * 检测 claw 配置（WS RPC gateway）
 * 优先级：config.claws.openclaw > 旧 config.openclaw（迁移提示）> auto-detect
 */
export function detectClawConfig(config: AichatConfig): ClawConfig {
	// 1. 新版配置 claws.openclaw
	if (config.claws?.openclaw?.gatewayUrl) {
		let token = config.claws.openclaw.token || '';
		if (!token) {
			token = readOpenclawGatewayToken() || config.openclaw?.token || '';
		}
		return {
			gatewayUrl: config.claws.openclaw.gatewayUrl,
			token,
		};
	}

	// 2. 旧版配置迁移提示
	if (config.openclaw?.url) {
		console.warn('[config] 检测到旧版 openclaw.url 配置（HTTP SSE），已切换为 WS RPC。');
		console.warn('[config] 建议将 config.jsonc 中的 openclaw.url 迁移到 claws.openclaw.gatewayUrl');
	}

	// 3. auto-detect：检查本地 openclaw 配置
	const gatewayToken = readOpenclawGatewayToken();
	if (gatewayToken) {
		console.log('[config] Auto-detected local openclaw installation');
		return { gatewayUrl: 'ws://localhost:18789', token: gatewayToken };
	}

	return {
		gatewayUrl: 'ws://localhost:18789',
		token: config.openclaw?.token || '',
	};
}

/**
 * 自动检测 openclaw 配置（旧版兼容，activate 命令使用）
 */
export function detectOpenclawConfig(config: AichatConfig): { url: string; token: string; agentId: string } {
	// 优先使用用户配置
	if (config.openclaw?.url && config.openclaw?.token) {
		return {
			url: config.openclaw.url,
			token: config.openclaw.token,
			agentId: config.openclaw.agentId || '',
		};
	}

	// auto-detect：检查本地 openclaw gateway
	const openclawConfigPath = resolve(homedir(), '.openclaw', 'openclaw.json');
	if (existsSync(openclawConfigPath)) {
		try {
			const raw = readFileSync(openclawConfigPath, 'utf-8');
			const parsed = JSON.parse(raw);
			const gatewayUrl = 'http://localhost:18789/v1/chat/completions';
			const gatewayToken = parsed.gateway?.auth?.token || process.env.OPENCLAW_TOKEN || '';
			console.log('[config] Auto-detected local openclaw installation');
			return { url: gatewayUrl, token: gatewayToken, agentId: '' };
		} catch {
			// fall through
		}
	}

	return {
		url: config.openclaw?.url || 'http://localhost:18789/v1/chat/completions',
		token: config.openclaw?.token || '',
		agentId: config.openclaw?.agentId || '',
	};
}
