import type { ChannelConfigAdapter, ResolvedAccount } from '../types.js';

/**
 * HuLa Channel 配置适配器
 * 从 openclaw.json 的 plugins.aichat-claw.hula 读取配置
 */
export function createHulaConfigAdapter(): ChannelConfigAdapter {
	return {
		listAccountIds(): string[] {
			return ['default'];
		},

		resolveAccount(accountId: string): ResolvedAccount | null {
			if (accountId === 'default') {
				return {
					accountId: 'default',
					name: 'HuLa',
					enabled: true,
				};
			}
			return null;
		},
	};
}
