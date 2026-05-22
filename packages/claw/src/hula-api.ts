/**
 * HuLa-Server HTTP API 客户端
 * 提供好友搜索、消息发送等能力，供 Agent Tools 调用
 */
export class HulaApiClient {
	private baseUrl: string;
	private token: string;

	constructor(baseUrl: string, token: string) {
		// 去掉末尾斜杠
		this.baseUrl = baseUrl.replace(/\/+$/, '');
		this.token = token;
	}

	/**
	 * 搜索好友
	 */
	async searchFriends(keyword: string): Promise<FriendSearchResult[]> {
		const resp = await this.get(`/api/im/friend/search?key=${encodeURIComponent(keyword)}`);
		return (resp.data as FriendSearchResult[]) ?? [];
	}

	/**
	 * 获取好友列表
	 */
	async getFriendList(): Promise<FriendInfo[]> {
		const resp = await this.get('/api/im/friend/list');
		return (resp.data as FriendInfo[]) ?? [];
	}

	/**
	 * 发送消息
	 * @param extra 额外字段（如 { autoReply: true, thinkingId: string }），server 侧不入库
	 */
	async sendMessage(roomId: number, content: string, extra?: Record<string, unknown>): Promise<{ msgId: number }> {
		const body: Record<string, unknown> = {
			roomId,
			msgType: 1, // 文本消息
			body: { content },
		};
		if (extra) {
			body.extra = extra;
		}
		const resp = await this.post('/api/im/chat/msg', body);
		return resp.data as { msgId: number };
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

	private headers(): Record<string, string> {
		return {
			Token: this.token,
		};
	}

	private async parseResponse(resp: Response): Promise<ApiResponse> {
		if (!resp.ok) {
			const text = await resp.text().catch(() => '');
			throw new Error(`HuLa API error: ${resp.status} ${text.substring(0, 200)}`);
		}
		const json = await resp.json() as ApiResponse;
		if (!json.success) {
			throw new Error(`HuLa API failed: ${json.msg || 'unknown error'}`);
		}
		return json;
	}
}

// ─── Types ───

interface ApiResponse {
	success: boolean;
	data?: unknown;
	msg?: string;
}

export interface FriendSearchResult {
	uid: number;
	name: string;
	avatar?: string;
}

export interface FriendInfo {
	uid: number;
	name: string;
	avatar?: string;
	activeStatus?: number;
}
