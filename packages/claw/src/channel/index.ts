import type { ChannelPlugin } from '../types.js';
import { createHulaConfigAdapter } from './config.js';

/**
 * HuLa Channel Plugin 定义
 * 最小实现：id=hula，支持 directMessages。回复走 aichat CLI（ADR-0004），无出站适配器。
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
};
