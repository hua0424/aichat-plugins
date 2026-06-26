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
	 * REQ-010 S3 #93 — 查询单个成员的公开资料。
	 * GET /api/im/user/getById/{uid} → data = 公开资料对象。
	 */
	async getMemberInfo(uid: number): Promise<Record<string, unknown>> {
		const resp = await this.get(`/api/im/user/getById/${uid}`);
		return (resp.data as Record<string, unknown>) ?? {};
	}

	/**
	 * REQ-010 S3 #93 — 拉取好友列表（单页，cursor 分页；agent 只取一页）。
	 * GET /api/im/user/friend/page?pageSize=<n> → data.list[] 映射为 {uid,name,account,remark}。
	 * server 把大整数 uid 序列化为字符串，这里统一 Number(...) 化。
	 */
	async listFriends(
		pageSize = 100,
	): Promise<Array<{ uid: number; name: string; account?: string; remark?: string }>> {
		const resp = await this.get(`/api/im/user/friend/page?pageSize=${pageSize}`);
		const data = resp.data as { list?: Array<Record<string, unknown>> } | undefined;
		const list = data?.list ?? [];
		return list.map((item) => ({
			uid: Number(item.uid),
			name: item.name as string,
			account: item.account as string | undefined,
			remark: item.remark as string | undefined,
		}));
	}

	/**
	 * REQ-010 S3 #93 — 按关键字搜索用户（参数名是 keyword，不是 key）。
	 * GET /api/im/user/search?keyword=<kw> → data.list[] 映射为 {uid,name,account,userType}。
	 */
	async searchUsers(
		keyword: string,
	): Promise<Array<{ uid: number; name: string; account?: string; userType?: number }>> {
		const resp = await this.get(`/api/im/user/search?keyword=${encodeURIComponent(keyword)}`);
		const data = resp.data as { list?: Array<Record<string, unknown>> } | undefined;
		const list = data?.list ?? [];
		return list.map((item) => ({
			uid: Number(item.uid),
			name: item.name as string,
			account: item.account as string | undefined,
			userType: item.userType === undefined ? undefined : Number(item.userType),
		}));
	}

	/**
	 * REQ-010 S4 #94 — 本 aiclaw（按 token 认证身份）已加入的群列表。
	 * GET /api/im/room/group/list（无参数；身份取自 token）→ data[] 映射。
	 * 单一 canonical `id` = server 的 roomId（Number(...) 化）——这才是 member-list
	 * 端点 / `--groupid` 接受的值；不再暴露独立的 groupId/roomId 二义键。
	 * `account` 是人类可读的群号，仅供展示。
	 */
	async listGroups(): Promise<
		Array<{
			id: number;
			name: string;
			memberNum?: number;
			onlineNum?: number;
			roleId?: number;
			account?: string;
		}>
	> {
		const resp = await this.get('/api/im/room/group/list');
		const list = (resp.data as Array<Record<string, unknown>>) ?? [];
		return list.map((item) => ({
			id: Number(item.roomId),
			name: item.groupName as string,
			memberNum: item.memberNum === undefined ? undefined : Number(item.memberNum),
			onlineNum: item.onlineNum === undefined ? undefined : Number(item.onlineNum),
			roleId: item.roleId === undefined ? undefined : Number(item.roleId),
			account: item.account as string | undefined,
		}));
	}

	/**
	 * REQ-010 S4 #94 — 查询某群成员（带在线状态）。
	 * GET /api/im/room/group/aiclaw/members?roomId=<roomId>&online=<bool> → data[] 映射。
	 * node 不判断房间类型：始终把 roomId 透传给 server，由 server 校验成员/类型。
	 * 业务错误时 server 返回 R{ success:false, msg }（"当前不在群聊中" / "未加入该群聊，无法查询成员"），
	 * parseResponse 会抛 `HuLa API failed: <msg>`，让调用方（capability）catch 后回传结构化错误给 agent。
	 */
	async listGroupMembers(
		roomId: number,
		online: boolean,
	): Promise<Array<{ uid: number; name: string; account?: string; online: boolean; roleId?: number }>> {
		const resp = await this.get(`/api/im/room/group/aiclaw/members?roomId=${roomId}&online=${online}`);
		const list = (resp.data as Array<Record<string, unknown>>) ?? [];
		return list.map((item) => ({
			uid: Number(item.uid),
			name: item.name as string,
			account: item.account as string | undefined,
			online: item.online === true,
			roleId: item.roleId === undefined ? undefined : Number(item.roleId),
		}));
	}

	/**
	 * 获取 aiclaw 群配置
	 */
	async getGroupConfig(aiclawUid: number, roomId: number): Promise<Record<string, unknown>> {
		const resp = await this.get(`/api/im/aiclaw/group/config?aiclawUid=${aiclawUid}&roomId=${roomId}`);
		return (resp.data as Record<string, unknown>) ?? {};
	}

	/**
	 * REQ #26: 拉取本 aiclaw（按 token 认证身份）的全部群配置，用于启动/重连预热。
	 * 无 query 参数；server 把大整数 roomId 序列化为字符串，这里统一 Number(...) 化。
	 */
	async listSelfGroupConfigs(): Promise<
		Array<{
			roomId: number;
			mentionRequired?: number;
			respondToAi?: number;
			rateLimitPerMinute?: number;
			dailyLimit?: number;
			/** REQ-009 #85: owner-configured absolute host workspace path (empty/absent → derive default). */
			workspaceDir?: string;
			/** REQ-009 #85: the group's human-readable group number ("groupkey"). */
			account?: string;
		}>
	> {
		const resp = await this.get('/api/im/aiclaw/group/config/list');
		const list = (resp.data as Array<Record<string, unknown>>) ?? [];
		return list.map((item) => ({
			roomId: Number(item.roomId),
			mentionRequired: item.mentionRequired === undefined ? undefined : Number(item.mentionRequired),
			respondToAi: item.respondToAi === undefined ? undefined : Number(item.respondToAi),
			rateLimitPerMinute: item.rateLimitPerMinute === undefined ? undefined : Number(item.rateLimitPerMinute),
			dailyLimit: item.dailyLimit === undefined ? undefined : Number(item.dailyLimit),
			// REQ-009 #85: server serializes these under exactly these names. Use `== null` to catch
			// BOTH JSON null (workspace_dir 默认 NULL) AND undefined — else String(null) → the literal
			// string "null", which deriveWorkspaceDir treats as an absolute override and feeds opencode
			// session.create as directory:"null" (fails the whole group round). null → undefined = default-derive.
			workspaceDir: item.workspaceDir == null ? undefined : String(item.workspaceDir),
			account: item.account == null ? undefined : String(item.account),
		}));
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

	/**
	 * REQ-009 #83：连接成功后上报本 aiclaw（按 token 认证身份）的 agent 类型，
	 * 供 server 持久化（覆盖只从 cache 预置、不再重新 activate 的身份）。
	 * server 按 connectionToken 识别身份，body 只带类型；upsert 幂等。
	 */
	async reportAgentType(agentType: string): Promise<void> {
		await this.post('/api/im/aiclaw/report-agent-type', { agentType });
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
