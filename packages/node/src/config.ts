import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentEntry } from './registry.js';

/**
 * ~/.aichat/ 目录
 */
export const AICHAT_HOME = resolve(process.env.AICHAT_HOME || join(homedir(), '.aichat'));

/**
 * 配置文件路径
 */
export const CONFIG_PATH = join(AICHAT_HOME, 'config.jsonc');

/**
 * 用户配置（~/.aichat/config.jsonc，可选手动编辑）
 */
export interface AichatConfig {
	server?: {
		url?: string;       // WS 地址，默认由插件内置
	};
	claws?: {
		openclaw?: {
			gatewayUrl?: string; // ws:// gateway 地址（新版）
			token?: string;
		};
	};
	/**
	 * REQ-008 #76: 多身份监督器的静态 agent 注册表。
	 * 每项 = 一个 aiclaw 身份（激活 token + 工具类型）；缺省/空表时回退单身份路径。
	 */
	agents?: AgentEntry[];
}

/**
 * 凭证（~/.aichat/credentials.jsonc，activate 后自动生成）
 */
export interface AichatCredentials {
	/**
	 * REQ-029 (#29): server 把 Java `Long` uid 序列化为字符串，插件内部一律按**不透明字符串**处理，
	 * 绝不 Number() 化（>2^53 会精度丢失、Map key 碰撞、路由错乱）。
	 */
	uid: string;
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
	const c = readJsonc(CONFIG_PATH);
	return c === undefined ? {} : (c as AichatConfig);
}

/**
 * 读取并解析 JSONC 文件（简易：去掉 // 注释行）。文件缺失或解析失败 → undefined（永不抛）。
 * config.jsonc 与 per-token 凭证缓存共用同一 strip-comment 解析（aichatoverview#165 单源）。
 */
export function readJsonc(path: string): unknown {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, 'utf-8').replace(/^\s*\/\/.*$/gm, ''));
	} catch {
		return undefined;
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
 * 优先级：config.claws.openclaw > auto-detect（本地 ~/.openclaw/openclaw.json gateway token）
 */
export function detectClawConfig(config: AichatConfig): ClawConfig {
	// 1. 配置 claws.openclaw
	if (config.claws?.openclaw?.gatewayUrl) {
		const token = config.claws.openclaw.token || readOpenclawGatewayToken() || '';
		return {
			gatewayUrl: config.claws.openclaw.gatewayUrl,
			token,
		};
	}

	// 2. auto-detect：检查本地 openclaw 配置
	const gatewayToken = readOpenclawGatewayToken();
	if (gatewayToken) {
		console.log('[config] Auto-detected local openclaw installation');
		return { gatewayUrl: 'ws://localhost:18789', token: gatewayToken };
	}

	return {
		gatewayUrl: 'ws://localhost:18789',
		token: '',
	};
}
