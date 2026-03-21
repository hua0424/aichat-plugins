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
		url?: string;       // Chat Completions API
		token?: string;     // gateway token
		agentId?: string;
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
const DEFAULT_SERVER_URL = 'ws://localhost:18760/ws/ws';

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
 * 获取完整运行配置
 */
export function getServerUrl(config: AichatConfig): string {
	return config.server?.url || DEFAULT_SERVER_URL;
}

/**
 * 自动检测 openclaw 配置
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
			// openclaw gateway 默认端口 18789
			const gatewayUrl = 'http://localhost:18789/v1/chat/completions';
			// gateway token 从 openclaw 配置或 .env 中读取
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
