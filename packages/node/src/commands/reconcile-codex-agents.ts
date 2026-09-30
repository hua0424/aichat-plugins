import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { AICHAT_SYSTEM_BEGIN, AICHAT_SYSTEM_END, renderSystemBlock } from '../agent/agents-md.js';
import { capabilitySocketPath } from '../capability/endpoint.js';
import { AICHAT_HOME, getServerUrl, loadConfig } from '../config.js';
import { restBaseUrlFromWsUrl } from '../api/hula-api.js';
import { withOfflineConversationStore } from './recover-run.js';

const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const validHash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const conflict = (message: string): never => { throw new Error(`PROMPT_SCOPE_CONFLICT: ${message}`); };
const readBounded = (file: string, max: number): Buffer => {
	if (statSync(file).size > max) throw new Error('approved file exceeds size limit');
	const bytes = readFileSync(file);
	if (bytes.length > max) throw new Error('approved file exceeds size limit');
	return bytes;
};

/** Offline owner-approved update of ONE legacy managed block in a controlled test directory.
 * The approval is an audit artifact; this CLI does NOT authenticate the owner or authorize arbitrary projects. */
export async function reconcileCodexAgents(args: string[], options: {
	home: string; serverNamespace: string; socketPath: string;
	/** Only for deterministic race testing; never used by the production CLI. */
	beforeCommit?: () => void;
}): Promise<void> {
	if (args.length !== 7 || args.some((arg) => !arg || arg.startsWith('--')))
		throw new Error('usage: aichat reconcile-codex-agents <uid> <room> <generation> <controlled-root> <absolute-AGENTS.md> <replacement-prompt-file|remove> <owner-approval.json>');
	const [uid, room, rawGeneration, controlledRoot, file, replacement, approvalFile] = args;
	const generation = Number(rawGeneration);
	if (!Number.isSafeInteger(generation) || generation < 1 || String(generation) !== rawGeneration ||
		!isAbsolute(controlledRoot) || !isAbsolute(file) || basename(file) !== 'AGENTS.md' ||
		!isAbsolute(approvalFile) || (replacement !== 'remove' && !isAbsolute(replacement)))
		throw new Error('invalid controlled test directory, AGENTS.md, generation or artifact');
	const bytes = readBounded(approvalFile, 65536);
	let raw: unknown;
	try { raw = JSON.parse(bytes.toString('utf8')); }
	catch { throw new Error('invalid approval artifact JSON'); }
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid approval artifact');
	const a = raw as Record<string, unknown>;
	const promptBytes = replacement === 'remove' ? undefined : readBounded(replacement, 65536);
	const prompt = promptBytes?.toString('utf8');
	if (prompt !== undefined && !Buffer.from(prompt, 'utf8').equals(promptBytes!))
		throw new Error('replacement prompt is not lossless UTF-8');
	if (prompt?.includes(AICHAT_SYSTEM_BEGIN) || prompt?.includes(AICHAT_SYSTEM_END))
		conflict('replacement prompt contains managed-block markers');
	if (a.owner === undefined || typeof a.owner !== 'string' || !a.owner.trim() || a.owner.length > 256 ||
		typeof a.approvalRef !== 'string' || !/^https:\/\/[^\s\x00-\x1f]{1,2048}$/.test(a.approvalRef) ||
		a.uid !== uid || a.room !== room || a.generation !== generation || a.controlledRoot !== controlledRoot ||
		a.file !== file || a.approvedControlledTestDirectory !== true || a.approvedOwnedBlock !== true ||
		a.approvedExclusiveTestWindow !== true ||
		a.operation !== (prompt === undefined ? 'remove' : 'replace') ||
		!validHash(a.originalFileSha256) || !validHash(a.originalBlockSha256) ||
		(prompt !== undefined && (!validHash(a.replacementPromptSha256) || a.replacementPromptSha256 !== sha(prompt))) ||
		(prompt === undefined && a.replacementPromptSha256 !== undefined))
		throw new Error('approval artifact must bind owner, target, original file/block SHA-256 and exact replacement operation');
	const root = realpathSync(controlledRoot), parent = realpathSync(dirname(file));
	const rel = relative(root, parent);
	if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel))
		conflict('target is not inside approved controlled test directory');
	const identity = lstatSync(file);
	if (identity.isSymbolicLink() || !identity.isFile()) conflict('target is not a regular non-symlink file');
	const current = readBounded(file, 1024 * 1024);
	const backupDir = join(options.home, 'codex', 'agent-block-backups');
	const backup = join(backupDir, `${a.originalFileSha256}.bak`);
	const original = sha(current) === a.originalFileSha256 ? current
		: existsSync(backup) ? readBounded(backup, 1024 * 1024) : conflict('file changed and approved backup is missing');
	const originalText = original.toString('utf8');
	if (!Buffer.from(originalText, 'utf8').equals(original)) conflict('AGENTS.md is not lossless UTF-8');
	const begin = originalText.indexOf(AICHAT_SYSTEM_BEGIN), end = originalText.indexOf(AICHAT_SYSTEM_END);
	if (begin < 0 || end < begin || originalText.indexOf(AICHAT_SYSTEM_BEGIN, begin + 1) !== -1 ||
		originalText.indexOf(AICHAT_SYSTEM_END, end + 1) !== -1) conflict('managed block markers missing, duplicated or malformed');
	const through = end + AICHAT_SYSTEM_END.length;
	const oldBlock = originalText.slice(begin, through);
	if (sha(original) !== a.originalFileSha256 || sha(oldBlock) !== a.originalBlockSha256)
		conflict('owner-approved original file or block hash differs');
	const nextText = originalText.slice(0, begin) + (prompt === undefined ? '' : renderSystemBlock(prompt)) + originalText.slice(through);
	const next = Buffer.from(nextText, 'utf8');
	await withOfflineConversationStore(options, async (store) => {
		const record = store.get(uid, room);
		if (!record || record.adapterInstanceId !== 'codex' || record.generation !== generation || record.pendingRuns?.length ||
			(record.state !== 'ready' && record.state !== 'suspended')) conflict('Codex owner binding changed or has pending work');
		// Existing known bindings in this workspace must not be rewritten by another identity's approval.
		const snapshot = JSON.parse(readFileSync(join(options.home, 'conversations.json'), 'utf8')) as {
			records: Array<{ identityId: string; roomId: string; nativeState?: { codex?: { workspace?: string } } }>;
		};
		for (const other of snapshot.records) {
			if (other.identityId === uid && other.roomId === room || !other.nativeState?.codex?.workspace) continue;
			let otherDir: string;
			try { otherDir = realpathSync(other.nativeState.codex.workspace); }
			catch { return conflict('another Codex workspace cannot be verified'); }
			if (otherDir === parent) conflict('another Codex conversation uses this workspace');
		}
		if (!current.equals(original)) {
			if (!current.equals(next) || sha(readFileSync(file)) !== sha(next))
				conflict('file changed since approved original; no replacement performed');
			return; // exact retry of an already committed replacement, with the original backup intact
		}
		mkdirSync(backupDir, { recursive: true, mode: 0o700 });
		if (!existsSync(backup)) writeFileSync(backup, original, { mode: 0o600, flag: 'wx' });
		if (sha(readFileSync(backup)) !== sha(original)) conflict('full backup conflicts with original file');
		const temp = join(parent, `.aichat-agents-${randomUUID()}.tmp`);
		try {
			const mode = statSync(file).mode & 0o777;
			writeFileSync(temp, next, { flag: 'wx', mode });
			if (process.platform !== 'win32') chmodSync(temp, mode);
			options.beforeCommit?.();
			// ponytail: offline owner coordination + immediate hash/inode CAS check cannot exclude a
			// non-cooperating writer between check and rename; use OS file leases if concurrent editing is required.
			const now = lstatSync(file);
			if (!now.isFile() || now.isSymbolicLink() || now.dev !== identity.dev || now.ino !== identity.ino ||
				sha(readFileSync(file)) !== sha(original) || realpathSync(dirname(file)) !== parent) conflict('file changed after backup; no replacement performed');
			renameSync(temp, file);
		} finally { if (existsSync(temp)) unlinkSync(temp); }
		console.log(`Codex AGENTS.md managed block reconciled; backup SHA-256 ${sha(original)}; result SHA-256 ${sha(next)}; approval artifact SHA-256 ${sha(bytes)}. Owner identity and block provenance were operator-verified, not authenticated by CLI.`);
	});
}

export async function handleReconcileCodexAgents(args: string[]): Promise<void> {
	try {
		const config = loadConfig();
		await reconcileCodexAgents(args, { home: AICHAT_HOME, serverNamespace: restBaseUrlFromWsUrl(getServerUrl(config)), socketPath: capabilitySocketPath() });
	} catch (error) {
		console.error(`reconcile-codex-agents: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
