/**
 * REQ-004 M3: aichat-node 内嵌轻量 HulaApiClient
 * 仅用于 autoReply 发送和 CLI 命令，不替代 aichat-claw 的 Tool 路径
 */

interface ApiResponse {
	success: boolean;
	data?: unknown;
	msg?: string;
}

export class HulaApiClient {
	private baseUrl: string;
	private token: string;

	constructor(baseUrl: string, token: string) {
		this.baseUrl = baseUrl.replace(/\/+$/, '');
		this.token = token;
	}

	/**
	 * 发送消息
	 * @param extra 额外字段（如 { autoReply: true }），server 侧不入库
	 */
	async sendMessage(
		roomId: number,
		content: string,
		extra?: Record<string, unknown>
	): Promise<{ msgId: number }> {
		const body: Record<string, unknown> = {
			roomId,
			msgType: 1, // 文本消息
			body: { content },
		};
		if (extra) {
			body.extra = extra;
		}
		const resp = await this.post('/api/im/chat/msg', body);
		const data = resp.data as { message?: { id?: number } } | undefined;
		return { msgId: data?.message?.id ?? 0 };
	}

	/**
	 * 搜索好友
	 */
	async searchFriends(keyword: string): Promise<{ uid: number; name: string; avatar?: string }[]> {
		const resp = await this.get(`/api/im/friend/search?key=${encodeURIComponent(keyword)}`);
		return (resp.data as { uid: number; name: string; avatar?: string }[]) ?? [];
	}

	/**
	 * 获取 aiclaw 群配置
	 */
	async getGroupConfig(aiclawUid: number, roomId: number): Promise<Record<string, unknown>> {
		const resp = await this.get(`/api/im/aiclaw/group/config?aiclawUid=${aiclawUid}&roomId=${roomId}`);
		return (resp.data as Record<string, unknown>) ?? {};
	}

	/**
	 * 更新 aiclaw 群配置
	 */
	async updateGroupConfig(
		aiclawUid: number,
		roomId: number,
		config: Record<string, unknown>
	): Promise<void> {
		await this.put('/api/im/aiclaw/group/config', { aiclawUid, roomId, ...config });
	}

	// ─── HTTP helpers ───

	private async get(path: string): Promise<ApiResponse> {
		const resp = await fetch(`${this.baseUrl}${path}`, {
			method: 'GET',
			headers: this.headers(),
		});
		return this.parseResponse(resp);
	}

	private async post(path: string, body: unknown): Promise<ApiResponse> {
		const resp = await fetch(`${this.baseUrl}${path}`, {
			method: 'POST',
			headers: {
				...this.headers(),
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
		});
		return this.parseResponse(resp);
	}

	private async put(path: string, body: unknown): Promise<ApiResponse> {
		const resp = await fetch(`${this.baseUrl}${path}`, {
			method: 'PUT',
			headers: {
				...this.headers(),
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
		});
		return this.parseResponse(resp);
	}

	private headers(): Record<string, string> {
		return {
			token: this.token,
		};
	}

	private async parseResponse(resp: Response): Promise<ApiResponse> {
		if (!resp.ok) {
			const text = await resp.text().catch(() => '');
			throw new Error(`HuLa API error: ${resp.status} ${text.substring(0, 200)}`);
		}
		const json = (await resp.json()) as ApiResponse;
		if (!json.success) {
			throw new Error(`HuLa API failed: ${json.msg || 'unknown error'}`);
		}
		return json;
	}
}

/**
 * 从 WS URL 推导 REST base URL
 * ws://host:port/api/ws/ws  → http://host:port
 * wss://host:port/api/ws/ws → https://host:port
 */
export function restBaseUrlFromWsUrl(wsUrl: string): string {
	try {
		const url = new URL(wsUrl);
		const protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
		// 去掉路径，只保留 host
		return `${protocol}//${url.host}`;
	} catch {
		// 回退：简单替换
		return wsUrl
			.replace(/^ws:\/\//, 'http://')
			.replace(/^wss:\/\//, 'https://')
			.replace(/\/api\/ws\/ws$/, '')
			.replace(/\/+$/, '');
	}
}
