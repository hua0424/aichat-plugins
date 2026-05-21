/**
 * REQ-004 M3: 群配置本地缓存
 * 接收 server 的 groupConfigChange WS 通知后刷新
 */

export interface GroupConfig {
	rateLimitPerMinute: number;
	mentionRequired: boolean;
	dailyLimit: number;
	respondToAi: boolean;
}

export class GroupConfigCache {
	/** key = `${aiclawUid}:${roomId}` */
	private cache = new Map<string, GroupConfig>();

	get(aiclawUid: number, roomId: number): GroupConfig | undefined {
		return this.cache.get(`${aiclawUid}:${roomId}`);
	}

	set(aiclawUid: number, roomId: number, config: GroupConfig): void {
		// CR-S8: normalize boolean fields — server sends 0/1, enforce boolean
		const normalized: GroupConfig = {
			...config,
			respondToAi: Boolean(config.respondToAi),
			mentionRequired: Boolean(config.mentionRequired),
		};
		this.cache.set(`${aiclawUid}:${roomId}`, normalized);
	}

	delete(aiclawUid: number, roomId: number): void {
		this.cache.delete(`${aiclawUid}:${roomId}`);
	}

	clear(): void {
		this.cache.clear();
	}
}
