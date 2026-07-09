/**
 * REQ-004 M3: aichat-cli group-config 命令
 */

import { loadConfig, getServerUrl, type AichatCredentials } from '../config.js';
import { loadAgentRegistry, resolveAgentCredential } from '../registry.js';
import { getMachineCode } from '../auth/machine.js';
import { HulaApiClient, restBaseUrlFromWsUrl } from '../api/hula-api.js';

export async function handleGroupConfig(args: string[]): Promise<void> {
	// REQ-029 (#29): roomId is an opaque string (never Number() — >2^53 corrupts).
	let roomId = '';
	const updates: Record<string, unknown> = {};

	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--room' && args[i + 1]) roomId = args[++i];
		if (args[i] === '--rate-limit' && args[i + 1]) updates.rateLimitPerMinute = Number(args[++i]);
		if (args[i] === '--daily-limit' && args[i + 1]) updates.dailyLimit = Number(args[++i]);
		if (args[i] === '--respond-to-ai' && args[i + 1]) updates.respondToAi = args[++i] === 'true' ? 1 : 0;
		if (args[i] === '--mention-required' && args[i + 1]) updates.mentionRequired = args[++i] === 'true' ? 1 : 0;
	}

	if (!roomId) {
		console.error('Usage: aichat group-config --room <roomId>');
		console.error('       aichat group-config --room <roomId> --rate-limit 20 --daily-limit 2000 --respond-to-ai true');
		process.exit(1);
	}

	const config = loadConfig();
	const registry = loadAgentRegistry(config);
	if (registry.length === 0) {
		console.error('No agents configured in ~/.aichat/config.jsonc. Run: aichat activate --token <token> and add it to the "agents" registry.');
		process.exit(1);
	}

	// ponytail: group-config is a single-identity admin CLI; resolve the first registered identity's
	// cached credential (per-token cache, no re-activation). Add a --token selector if multi-identity
	// group-config is ever actually needed.
	const serverUrl = getServerUrl(config);
	const httpBase = serverUrl
		.replace('ws://', 'http://')
		.replace('wss://', 'https://')
		.replace(/\/ws\/ws$/, '');
	let credentials: AichatCredentials;
	try {
		credentials = await resolveAgentCredential(registry[0], { machineCode: getMachineCode(), httpBase });
	} catch (err) {
		console.error(`Credential resolution failed: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}

	const restBaseUrl = restBaseUrlFromWsUrl(serverUrl);
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
