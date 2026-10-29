/**
 * REQ-004 M3: 群配置本地缓存
 *
 * aichatoverview#484 (T3) 修正：这里不再把 server 推送的载荷当成事实写入。
 * - WS `groupConfigChange` 只是「这个 (aiclaw, room) 可能变了」的提示 → {@link markStale}，
 *   真实值由使用方在有界刷新里读当前事实（{@link HulaApiClient.getGroupConfigCurrent}）。
 *   原因：旧包/乱序提示会把已批准的 approved、已撤销的 workspaceDir 覆盖回旧值，且插件无法判断版本。
 * - 每条记录带 `approved` 与 `stale`：approved 未显式出现时不得当作 true（服务端默认 0=未批准）。
 * - 记录是「上次读到的值 + 是否可能过期」，不是执行授权凭据。
 */

export interface GroupConfig {
	rateLimitPerMinute: number;
	mentionRequired: boolean;
	dailyLimit: number;
	respondToAi: boolean;
	/**
	 * REQ-009 #82/#85: explicit approval. server 默认 0（未批准）。缺省按未批准处理，
	 * 不得因为字段缺失就放行 AI 响应。
	 */
	approved: boolean;
	/**
	 * REQ-009 #85: owner-configured absolute host path for the opencode workspace of this
	 * (aiclaw, group). Empty/absent → plugins derives a default. Absolute override wins.
	 */
	workspaceDir?: string;
	/**
	 * REQ-009 #85: the group's human-readable group number ("groupkey"). Used as the default
	 * workspace-dir segment (`<base>/<aiclawUid>/group/<account>`) so the owner can cd into a
	 * stable, human-readable path on the host. Falls back to roomId when missing.
	 */
	account?: string;
	/**
	 * aichatoverview#485 (T4): the server's authorization generation this record was read under.
	 * It is NOT a permission — it names *which* authorization context the input belonged to, so a
	 * run started later cannot be re-stamped with a newer generation: START carries this value and
	 * the server re-derives it from current facts and rejects on mismatch.
	 */
	authorizationEpoch?: string;
}

interface Entry {
	config: GroupConfig;
	/** 收到提示后置位：值可能过期，使用方应触发一次有界当前读。 */
	stale: boolean;
	/** 最近一次确实读到当前事实的时间戳（ms），便于观测未校准年龄。 */
	calibratedAt: number;
	/** 代次：提示到达 +1，用于丢弃早于最新提示的读结果。 */
	generation: number;
}

export class GroupConfigCache {
	/** key = `${aiclawUid}:${roomId}` */
	private cache = new Map<string, Entry>();

	private key(aiclawUid: string, roomId: string): string {
		return `${aiclawUid}:${roomId}`;
	}

	get(aiclawUid: string, roomId: string): GroupConfig | undefined {
		return this.cache.get(this.key(aiclawUid, roomId))?.config;
	}

	/** 这条记录当前是否已被提示为可能过期（没有记录不算过期）。 */
	isStale(aiclawUid: string, roomId: string): boolean {
		return this.cache.get(this.key(aiclawUid, roomId))?.stale ?? false;
	}

	/**
	 * 写入「读到的当前事实」。`generation` 由调用方在发起读取前捕获，若期间又收到提示则代次已推进，
	 * 这次结果必须丢弃——避免慢响应把更新的事实盖回旧值。
	 */
	set(aiclawUid: string, roomId: string, config: GroupConfig, generation?: number): boolean {
		const key = this.key(aiclawUid, roomId);
		const current = this.cache.get(key);
		if (generation !== undefined && current && current.generation !== generation) {
			return false;
		}
		// CR-S8: normalize boolean fields — server sends 0/1, enforce boolean
		const normalized: GroupConfig = {
			...config,
			respondToAi: Boolean(config.respondToAi),
			mentionRequired: Boolean(config.mentionRequired),
			approved: config.approved === true,
			// REQ-009 #85: carry workspaceDir/account through as-is when present, else undefined.
			workspaceDir: config.workspaceDir,
			account: config.account,
			// aichatoverview#485: same passthrough for the server-derived authorization generation.
			authorizationEpoch: config.authorizationEpoch,
		};
		this.cache.set(key, {
			config: normalized,
			stale: false,
			calibratedAt: Date.now(),
			generation: current ? current.generation : 0,
		});
		return true;
	}

	/**
	 * 收到「可能变了」的提示：只标记过期并推进代次，不应用载荷。
	 * 返回当前代次，调用方用它作为发起读取的凭据（无记录时返回 0，仍然允许首次读取）。
	 */
	markStale(aiclawUid: string, roomId: string): number {
		const key = this.key(aiclawUid, roomId);
		const current = this.cache.get(key);
		if (!current) {
			return 0;
		}
		current.stale = true;
		current.generation += 1;
		return current.generation;
	}

	generationOf(aiclawUid: string, roomId: string): number {
		return this.cache.get(this.key(aiclawUid, roomId))?.generation ?? 0;
	}

	calibratedAtOf(aiclawUid: string, roomId: string): number | undefined {
		return this.cache.get(this.key(aiclawUid, roomId))?.calibratedAt;
	}

	delete(aiclawUid: string, roomId: string): void {
		this.cache.delete(this.key(aiclawUid, roomId));
	}

	clear(): void {
		this.cache.clear();
	}
}
