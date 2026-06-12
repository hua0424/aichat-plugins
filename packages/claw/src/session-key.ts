/**
 * REQ-004 S2: sessionKey 解析（纯函数）。
 *
 * sessionKey 约定编码会话归属：`aiclaw-{uid}-room-{roomId}`。
 * openclaw 会把它规范化为带 agent 命名空间前缀的形式，例如
 * `agent:main:aiclaw-{uid}-room-{roomId}`（spike #2 实测），解析时需容忍该前缀。
 *
 * uid / roomId 保留为字符串，避免大整数（雪花 ID）精度丢失。
 */
export interface SessionOwner {
	aiclawUid: string;
	roomId: string;
}

// 左边界：字符串起始，或 openclaw 规范化前缀的分隔符（: 或 /），
// 防止 notaiclaw-... 这类粘连词被误匹配。
const SESSION_KEY_RE = /(?:^|[:/])aiclaw-(\d+)-room-(\d+)$/;

/**
 * 解析 sessionKey → { aiclawUid, roomId }；无法解析返回 null。
 */
export function parseSessionKey(sessionKey: string | null | undefined): SessionOwner | null {
	if (!sessionKey) {
		return null;
	}
	const match = SESSION_KEY_RE.exec(sessionKey);
	if (!match) {
		return null;
	}
	return { aiclawUid: match[1], roomId: match[2] };
}
