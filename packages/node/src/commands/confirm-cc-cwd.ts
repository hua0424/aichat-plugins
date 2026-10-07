import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { capabilitySocketPath } from '../capability/endpoint.js';
import { AICHAT_HOME, getServerUrl, loadConfig } from '../config.js';
import { restBaseUrlFromWsUrl } from '../api/hula-api.js';
import { withOfflineConversationStore } from './recover-run.js';

/** #343: CC 原生历史布局 <configDir>/projects/<cwd-slug>/<sessionId>.jsonl（部署环境实测：
 * '/'→'-'，如 /workspace → -workspace）。Windows 盘符冒号在文件名中非法，一并替换；
 * 恢复现场在 Linux 运行环境，POSIX 布局必须逐字节保真。 */
export function ccNativeHistoryFile(configDir: string, cwd: string, sessionId: string): string {
	return join(configDir, 'projects', cwd.split('/').join('-').replace(/:/g, '-'), `${sessionId}.jsonl`);
}

/** Offline maintenance, NOT product-owner authentication. Human operator must independently verify
 * the approval reference is from the owner, explicitly names ORIGINAL cwd, and belongs to this binding.
 * Never invoke from an agent capability or infer cwd from current config/JSONL search misses. */
export async function confirmCcCwd(args: string[], options: { home: string; serverNamespace: string; socketPath: string; ccConfigDir?: string }): Promise<void> {
	if (args.length !== 6 || args.some((arg) => !arg || arg.startsWith('--')))
		throw new Error('usage: aichat confirm-cc-cwd <uid> <room> <sessionId> <generation> <ORIGINAL-absolute-cwd> <owner-approval.json>');
	const [uid, room, sessionId, rawGeneration, cwd, file] = args;
	const generation = Number(rawGeneration);
	if (!Number.isSafeInteger(generation) || generation < 1 || String(generation) !== rawGeneration || !isAbsolute(cwd))
		throw new Error('invalid generation or original absolute cwd');
	// The artifact is auditable evidence, not an owner credential. Its external reference MUST be
	// independently checked by a human against the product owner's identity before invoking this command.
	const bytes = readFileSync(file);
	if (bytes.length > 65536) throw new Error('approval artifact too large');
	const approval: unknown = JSON.parse(bytes.toString('utf8'));
	if (!approval || typeof approval !== 'object' || Array.isArray(approval)) throw new Error('invalid approval artifact');
	const a = approval as Record<string, unknown>;
	if (a.uid !== uid || a.room !== room || a.sessionId !== sessionId || a.generation !== generation ||
		a.originalCwd !== cwd || typeof a.owner !== 'string' || !a.owner.trim() ||
		a.owner.length > 256 || typeof a.approvalRef !== 'string' ||
		!/^https:\/\/[^\s\x00-\x1f]{1,2048}$/.test(a.approvalRef) ||
		a.approvedOriginalCwd !== true)
		throw new Error('approval artifact does not explicitly bind owner, original cwd, uid/room/sessionId/generation and HTTPS reference');
	// #343: 只有可信目录 **且** 该目录下确有可续会话的原生历史时才允许解除暂停；缺历史的「恢复」
	// 实际是换目录新会话，属于 owner 的 reset 决策，不能由本命令悄悄放行。
	if (!existsSync(cwd)) throw new Error(`original cwd no longer exists on this host: ${cwd}`);
	const ccConfigDir = options.ccConfigDir ?? (process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude'));
	const historyFile = ccNativeHistoryFile(ccConfigDir, cwd, sessionId);
	if (!existsSync(historyFile)) throw new Error(`native CC history for resume not found: ${historyFile}`);
	const hash = createHash('sha256').update(bytes).digest('hex');
	await withOfflineConversationStore(options, async (store) => {
		const record = store.confirmCcOriginalCwd(uid, room, sessionId, generation, cwd, a.approvalRef as string, hash);
		console.log(`CC original cwd recorded for uid ${JSON.stringify(uid)} room ${JSON.stringify(room)} session ${JSON.stringify(sessionId)} generation ${record.generation}; artifact SHA-256 ${hash}; approval ${JSON.stringify(a.approvalRef)}. Native history verified at ${JSON.stringify(historyFile)}. Owner identity verification was operator responsibility, not performed by CLI.`);
	});
}

export async function handleConfirmCcCwd(args: string[]): Promise<void> {
	try {
		const config = loadConfig();
		await confirmCcCwd(args, { home: AICHAT_HOME, serverNamespace: restBaseUrlFromWsUrl(getServerUrl(config)), socketPath: capabilitySocketPath() });
	} catch (err) {
		console.error(`confirm-cc-cwd: ${err instanceof Error ? err.message : String(err)}`);
		process.exitCode = 1;
	}
}
