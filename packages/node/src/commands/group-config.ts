/**
 * REQ-004 M3: aichat-cli group-config 命令
 */

import { loadConfig, loadCredentials, getServerUrl } from '../config.js';
import { HulaApiClient, restBaseUrlFromWsUrl } from '../api/hula-api.js';

export async function handleGroupConfig(args: string[]): Promise<void> {
	let roomId = 0;
	const updates: Record<string, unknown> = {};

	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--room' && args[i + 1]) roomId = Number(args[++i]);
		if (args[i] === '--rate-limit' && args[i + 1]) updates.rateLimitPerMinute = Number(args[++i]);
		if (args[i] === '--daily-limit' && args[i + 1]) updates.dailyLimit = Number(args[++i]);
		if (args[i] === '--respond-to-ai' && args[i + 1]) updates.respondToAi = args[++i] === 'true';
		if (args[i] === '--mention-required' && args[i + 1]) updates.mentionRequired = args[++i] === 'true';
	}

	if (!roomId) {
		console.error('Usage: aichat group-config --room <roomId>');
		console.error('       aichat group-config --room <roomId> --rate-limit 20 --daily-limit 2000 --respond-to-ai true');
		process.exit(1);
	}

	const credentials = loadCredentials();
	if (!credentials) {
		console.error('Not activated. Run: aichat activate');
		process.exit(1);
	}

	const config = loadConfig();
	const restBaseUrl = restBaseUrlFromWsUrl(getServerUrl(config));
	const api = new HulaApiClient(restBaseUrl, credentials.connectionToken);

	if (Object.keys(updates).length === 0) {
		// 查询模式
		const current = await api.getGroupConfig(credentials.uid, roomId);
		console.log(`Group config for room ${roomId}:`);
		console.log(JSON.stringify(current, null, 2));
	} else {
		// 更新模式
		await api.updateGroupConfig(credentials.uid, roomId, updates);
		console.log(`Group config updated for room ${roomId}`);
		console.log(JSON.stringify(updates, null, 2));
	}
}
