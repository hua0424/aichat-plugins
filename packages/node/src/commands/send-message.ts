/**
 * REQ-004 M3: aichat-cli send-message 命令
 */

import { loadConfig, loadCredentials, getServerUrl } from '../config.js';
import { HulaApiClient, restBaseUrlFromWsUrl } from '../api/hula-api.js';

export async function handleSendMessage(args: string[]): Promise<void> {
	let roomId = 0;
	let toUid = 0;
	let content = '';

	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--room' && args[i + 1]) roomId = Number(args[++i]);
		if (args[i] === '--to' && args[i + 1]) toUid = Number(args[++i]);
		if (args[i] === '--content' && args[i + 1]) content = args[++i];
	}

	if (!content?.trim()) {
		console.error('Usage: aichat send-message --room <roomId> --content "<text>"');
		console.error('       aichat send-message --to <uid> --content "<text>"');
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

	let targetRoomId = roomId;
	if (!targetRoomId && toUid) {
		// 通过好友 UID 解析 roomId（搜索好友后取私聊房间）
		targetRoomId = await resolveRoomIdForUid(toUid, api);
	}

	if (!targetRoomId) {
		console.error('Error: must specify --room or --to');
		process.exit(1);
	}

	const result = await api.sendMessage(targetRoomId, content.trim());
	console.log(`Message sent: msgId=${result.msgId} roomId=${targetRoomId}`);
}

/**
 * 通过 UID 解析私聊房间 ID
 * 简化实现：搜索好友后，尝试通过 API 获取或创建会话
 */
async function resolveRoomIdForUid(uid: number, api: HulaApiClient): Promise<number> {
	// 先搜索好友确认存在
	const friends = await api.searchFriends(String(uid));
	const friend = friends.find((f) => f.uid === uid);
	if (!friend) {
		throw new Error(`Friend not found: uid=${uid}`);
	}

	// TODO: 需要通过 server API 获取/创建私聊 roomId
	// 当前简化：直接返回 uid 作为 roomId（仅用于测试，实际需调用会话创建 API）
	console.warn(`[cli] resolveRoomIdForUid: returning uid=${uid} as roomId (simplified)`);
	return uid;
}
