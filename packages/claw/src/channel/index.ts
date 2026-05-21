import type { ChannelPlugin } from '../types.js';
import { createHulaConfigAdapter } from './config.js';
import { createHulaOutboundAdapter } from './outbound.js';

/**
 * HuLa Channel Plugin 定义
 * 最小实现：id=hula，支持 directMessages
 */
export const hulaChannel: ChannelPlugin = {
	id: 'hula',
	meta: {
		label: 'HuLa',
		blurb: 'HuLa IM platform channel',
	},
	capabilities: {
		chatTypes: ['direct', 'group'],
	},
	config: createHulaConfigAdapter(),
	outbound: createHulaOutboundAdapter(),
};
