/**
 * REQ-004 M3: 群配置本地缓存
 * 接收 server 的 groupConfigChange WS 通知后刷新
 */

export interface GroupConfig {
	rateLimitPerMinute: number;
	mentionRequired: boolean;
	dailyLimit: number;
	respondToAi: boolean;
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
}

export class GroupConfigCache {
	/** key = `${aiclawUid}:${roomId}` */
	private cache = new Map<string, GroupConfig>();

	get(aiclawUid: string, roomId: string): GroupConfig | undefined {
		return this.cache.get(`${aiclawUid}:${roomId}`);
	}

	set(aiclawUid: string, roomId: string, config: GroupConfig): void {
		// CR-S8: normalize boolean fields — server sends 0/1, enforce boolean
		const normalized: GroupConfig = {
			...config,
			respondToAi: Boolean(config.respondToAi),
			mentionRequired: Boolean(config.mentionRequired),
			// REQ-009 #85: carry workspaceDir/account through as-is when present, else undefined.
			workspaceDir: config.workspaceDir,
			account: config.account,
		};
		this.cache.set(`${aiclawUid}:${roomId}`, normalized);
	}

	delete(aiclawUid: string, roomId: string): void {
		this.cache.delete(`${aiclawUid}:${roomId}`);
	}

	clear(): void {
		this.cache.clear();
	}
}
