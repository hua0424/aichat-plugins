/**
 * REQ-004: HulaApiClient 实例池（方案 B 保底）
 *
 * 群聊场景下每个 aiclaw 可能有独立 token。
 * 若 openclaw Tool execution context 不提供 agent credential，
 * 则通过 instance pool 按 aiclawUid 维护独立的 HulaApiClient。
 *
 * 当前限制：AgentTool.execute 不接收 context，故 client 选择
 * 需依赖 openclaw 后续支持或 agent 在 params 中显式传递身份。
 */

import { HulaApiClient } from './hula-api.js';

export class HulaApiClientPool {
	private pool = new Map<string, HulaApiClient>();
	private defaultClient: HulaApiClient | null = null;
	private serverUrl: string;

	constructor(serverUrl: string) {
		this.serverUrl = serverUrl;
	}

	/** 注册默认客户端（全局 token，向后兼容） */
	setDefault(token: string): void {
		this.defaultClient = new HulaApiClient(this.serverUrl, token);
	}

	/** 按 aiclawUid 注册独立客户端 */
	register(aiclawUid: string, token: string): void {
		this.pool.set(aiclawUid, new HulaApiClient(this.serverUrl, token));
	}

	/**
	 * 获取客户端。
	 * - 不传 uid：返回默认客户端（如 channel.outbound 无会话上下文场景）。
	 * - 传 uid 且池中命中：返回该 aiclaw 专属客户端。
	 * - 传 uid 未命中：
	 *   - 多 token 模式（池非空）：拒绝——不可用错误身份冒名发送。
	 *   - 单 token 模式（池为空）：回退默认（默认即本进程唯一身份，向后兼容）。
	 */
	get(aiclawUid?: string): HulaApiClient {
		if (aiclawUid) {
			const client = this.pool.get(aiclawUid);
			if (client) return client;
			// 多 token 模式下未命中 = 误路由，绝不回退到错误身份
			if (this.pool.size > 0) {
				throw new Error(`No HulaApiClient registered for aiclaw ${aiclawUid} (multi-token mode)`);
			}
		}
		if (this.defaultClient) return this.defaultClient;
		throw new Error('No HulaApiClient available: call setDefault() or register() first');
	}

	/** 是否已注册任何客户端 */
	get hasAnyClient(): boolean {
		return this.defaultClient !== null || this.pool.size > 0;
	}
}
