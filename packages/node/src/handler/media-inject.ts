import type { ReceivedMessage, MediaMessageBody, TextMessageBody } from '../stream/protocol.js';
import { isMediaMessageBody } from '../stream/protocol.js';

/**
 * REQ-007 #73: 把一条 receiveMessage 的 message 归一化为「喂给 openclaw agent 的纯文本」。
 *
 * 纯函数（无 I/O、无日志），完全可单测：
 *  - type=1（文本）：trim 后非空则返回 content，否则 null。
 *  - type=3（IMG）/ type=4（FILE）：返回 file-attachment 注入文本；url 缺失/空白时返回 null（防御）。
 *  - 其它 type：返回 null（音视频/撤回等暂不在范围内，保持原跳过语义）。
 *
 * REQ-146 (#146) sign-on-access：server 已停发 7 天下载地址，新的媒体消息 body.url 不再可用，
 * 由调用方先 async 换取一个短效签名地址（HulaApiClient.signDownload）再作为 `resolvedFileUrl` 传入。
 * 本函数保持纯（无 I/O）：仅在 `resolvedFileUrl` 缺省（老消息 / 无 apiClient）时回退到 body.url。
 *
 * 注入文本格式严格对齐 PRD #69，且**绝不**包含 `[SYSTEM]` / `[System Message]` 之类括号标记
 * （会被 openclaw 安全过滤——见 plugins CLAUDE.md 不变量 #2）。
 *
 * @param resolvedFileUrl 调用方换取的短效签名地址（type 3/4 用）；缺省则回退 body.url。
 * @returns 归一化后的 agent 输入文本；不可触发时返回 null。
 */
export function buildAgentInjection(
	message: ReceivedMessage['message'],
	resolvedFileUrl?: string,
): string | null {
	const { type, body } = message;

	if (type === 1) {
		const content = (body as TextMessageBody).content;
		const trimmed = content?.trim();
		return trimmed ? content : null;
	}

	if (type === 3 || type === 4) {
		if (!isMediaMessageBody(body)) return null;
		return buildFileAttachment(body, resolvedFileUrl);
	}

	// 其它类型（音频/视频/撤回……）超出范围，跳过。
	return null;
}

/**
 * 构造 file-attachment 注入块；url 缺失/空白返回 null。
 * REQ-146：优先用调用方换取的短效签名地址 `resolvedFileUrl`；仅在其缺省时回退 body.url（老消息）。
 */
function buildFileAttachment(body: MediaMessageBody, resolvedFileUrl?: string): string | null {
	const url = resolvedFileUrl?.trim() || body.url?.trim();
	if (!url) return null;

	const name = resolveName(body);
	const size = body.size ?? 0;

	const lines: string[] = [`url: ${url}`, `name: ${name}`];
	// mime 是唯一可选字段：仅在存在且非空白时输出该行。
	const mime = body.mime?.trim();
	if (mime) lines.push(`mime: ${mime}`);
	// size 行始终在 mime 之后（行序：url, name, mime, size）。
	lines.push(`size: ${size}`);
	// REQ-146：短效链接提示——签名地址 ~5 分钟过期，提示 agent 即时取用（不加括号系统标记）。
	lines.push('note: 链接短效有效，需要时立即获取，过期需重新索取');

	let out = ['用户发送了一个文件附件：', '', '```file-attachment', ...lines, '```'].join('\n');

	// 媒体附带的文字附言（body.content）：仅在 trim 后非空时追加。
	const caption = body.content?.trim();
	if (caption) {
		out += `\n\n用户附言：${caption}`;
	}

	return out;
}

/**
 * 文件名解析优先级：
 *  1. body.fileName（trim 后非空）
 *  2. 否则从 URL path 末段派生（去掉 ?query，取最后一个 / 后的段，百分号解码）
 *  3. 兜底 "file"
 */
function resolveName(body: MediaMessageBody): string {
	const fileName = body.fileName?.trim();
	if (fileName) return fileName;

	const derived = deriveNameFromUrl(body.url);
	return derived ?? 'file';
}

function deriveNameFromUrl(url: string): string | null {
	// 去掉 query（? 之后）与 fragment（# 之后），取最后一段。
	const path = url.split('?')[0].split('#')[0];
	const segment = path.split('/').pop();
	if (!segment) return null;
	let decoded: string;
	try {
		decoded = decodeURIComponent(segment);
	} catch {
		decoded = segment;
	}
	const trimmed = decoded.trim();
	return trimmed || null;
}
