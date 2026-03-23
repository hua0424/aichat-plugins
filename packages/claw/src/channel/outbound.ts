import type { ChannelOutboundAdapter } from '../types.js';

/**
 * HuLa Channel 出站适配器
 * Phase 2 Agent Tools 时完善，当前为骨架实现
 */
export function createHulaOutboundAdapter(): ChannelOutboundAdapter {
	return {
		async sendText(params) {
			// TODO Phase 2: 通过 HuLa API 发送消息
			console.warn(`[hula-channel] sendText not implemented yet: to=${params.to}`);
			return { ok: false, error: 'not implemented' };
		},
	};
}
