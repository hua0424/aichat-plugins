import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { capabilitySocketPath } from '../capability/endpoint.js';
import { AICHAT_HOME, getServerUrl, loadConfig } from '../config.js';
import { restBaseUrlFromWsUrl } from '../api/hula-api.js';
import { withOfflineConversationStore } from './recover-run.js';

/** Offline maintenance only. The operator independently verifies the HTTPS reference and product owner's identity;
 * neither this CLI nor the artifact authenticates the owner. Never expose through an agent capability. */
export async function confirmCodexThread(args: string[], options: { home: string; serverNamespace: string; socketPath: string }): Promise<void> {
	if (args.length !== 6 || args.some((arg) => !arg || arg.startsWith('--')))
		throw new Error('usage: aichat confirm-codex-thread <uid> <room> <threadId> <generation> <ORIGINAL-absolute-cwd> <owner-approval-with-original-prompt.json>');
	const [uid, room, threadId, rawGeneration, workspace, approvalFile] = args;
	const generation = Number(rawGeneration);
	if (!Number.isSafeInteger(generation) || generation < 1 || String(generation) !== rawGeneration || !isAbsolute(workspace))
		throw new Error('invalid generation or ORIGINAL absolute cwd');
	const bytes = readFileSync(approvalFile);
	if (bytes.length > 131072) throw new Error('approval artifact too large');
	let approval: unknown;
	try { approval = JSON.parse(bytes.toString('utf8')); }
	catch { throw new Error('invalid approval artifact JSON'); }
	if (!approval || typeof approval !== 'object' || Array.isArray(approval)) throw new Error('invalid approval artifact');
	const a = approval as Record<string, unknown>;
	if (typeof a.originalPrompt !== 'string' || Buffer.byteLength(a.originalPrompt, 'utf8') > 65536)
		throw new Error('original prompt must be a string of at most 65536 UTF-8 bytes');
	const originalPrompt = a.originalPrompt;
	const promptHash = createHash('sha256').update(originalPrompt).digest('hex');
	if (a.uid !== uid || a.room !== room || a.threadId !== threadId || a.generation !== generation ||
		a.originalCwd !== workspace || a.originalPromptSha256 !== promptHash || a.approvedOriginalThread !== true ||
		typeof a.owner !== 'string' || !a.owner.trim() || a.owner.length > 256 ||
		typeof a.approvalRef !== 'string' || !/^https:\/\/[^\s\x00-\x1f]{1,2048}$/.test(a.approvalRef))
		throw new Error('approval artifact must explicitly bind owner, ORIGINAL cwd/prompt hash, uid/room/threadId/generation and HTTPS reference');
	const artifactHash = createHash('sha256').update(bytes).digest('hex');
	await withOfflineConversationStore(options, async (store) => {
		const record = store.confirmCodexOriginalThread(uid, room, threadId, generation, workspace, originalPrompt,
			a.approvalRef as string, artifactHash);
		console.log(`Codex legacy thread confirmed for uid ${JSON.stringify(uid)} room ${JSON.stringify(room)} thread ${JSON.stringify(threadId)} generation ${record.generation}; prompt SHA-256 ${promptHash}; artifact SHA-256 ${artifactHash}; approval ${JSON.stringify(a.approvalRef)}. Owner identity verification was operator responsibility, not performed by CLI.`);
	});
}

export async function handleConfirmCodexThread(args: string[]): Promise<void> {
	try {
		const config = loadConfig();
		await confirmCodexThread(args, { home: AICHAT_HOME, serverNamespace: restBaseUrlFromWsUrl(getServerUrl(config)), socketPath: capabilitySocketPath() });
	} catch (err) {
		console.error(`confirm-codex-thread: ${err instanceof Error ? err.message : String(err)}`);
		process.exitCode = 1;
	}
}
