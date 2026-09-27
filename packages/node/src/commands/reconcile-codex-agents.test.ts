import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AICHAT_SYSTEM_BEGIN, AICHAT_SYSTEM_END, renderSystemBlock } from '../agent/agents-md.js';
import { ConversationStore } from '../capability/conversations.js';
import { reconcileCodexAgents } from './reconcile-codex-agents.js';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

function fixture() {
	const home = mkdtempSync(join(tmpdir(), 'codex-reconcile-')); directories.push(home);
	const root = join(home, 'controlled');
	const folder = join(root, 'workspace');
	mkdirSync(folder, { recursive: true });
	const file = join(folder, 'AGENTS.md');
	const block = renderSystemBlock('old persona');
	const original = `owner before\n${block}\nowner after\n`;
	writeFileSync(file, original);
	const replacement = join(home, 'new-prompt.txt'); writeFileSync(replacement, 'new persona');
	const artifact = join(home, 'approval.json');
	const approval = { uid: '42', room: 'group', generation: 1, controlledRoot: root, file,
		owner: 'owner-confirmed-offline', approvalRef: 'https://github.com/example/issue/1#issuecomment-2',
		approvedControlledTestDirectory: true, approvedOwnedBlock: true, approvedExclusiveTestWindow: true, operation: 'replace',
		originalFileSha256: sha(original), originalBlockSha256: sha(block), replacementPromptSha256: sha('new persona') };
	writeFileSync(artifact, JSON.stringify(approval));
	const opts = { home, serverNamespace: 'test',
		socketPath: process.platform === 'win32' ? `\\\\.\\pipe\\codex-reconcile-${process.pid}-${Date.now()}` : join(home, 'capability.sock') };
	const store = new ConversationStore({ home, serverNamespace: opts.serverNamespace, activeUids: new Set(['42']), activeProviders: new Map([['42', 'codex']]) });
	store.getOrCreate('42', 'group'); store.close();
	return { home, root, folder, file, block, original, replacement, artifact, approval, opts,
		args: ['42', 'group', '1', root, file, replacement, artifact] };
}

it('backs up full file and replaces only owner-approved block without modifying user text', async () => {
	const f = fixture();
	await reconcileCodexAgents(f.args, f.opts);
	expect(readFileSync(f.file, 'utf8')).toBe(`owner before\n${renderSystemBlock('new persona')}\nowner after\n`);
	expect(readFileSync(join(f.home, 'codex', 'agent-block-backups', `${sha(f.original)}.bak`), 'utf8')).toBe(f.original);
	await reconcileCodexAgents(f.args, f.opts); // exact retry is a no-op and keeps the backup
	expect(readFileSync(f.file, 'utf8')).toBe(`owner before\n${renderSystemBlock('new persona')}\nowner after\n`);
	expect(existsSync(join(f.home, 'conversation-writer.lock'))).toBe(false);
});

it('can remove only the confirmed block and preserve surrounding user text', async () => {
	const f = fixture();
	writeFileSync(f.artifact, JSON.stringify({ ...f.approval, operation: 'remove', replacementPromptSha256: undefined }));
	await reconcileCodexAgents([...f.args.slice(0, 5), 'remove', f.artifact], f.opts);
	expect(readFileSync(f.file, 'utf8')).toBe('owner before\n\nowner after\n');
});

it('rejects a replacement prompt containing reserved managed markers', async () => {
	const f = fixture();
	const prompt = `new persona ${AICHAT_SYSTEM_BEGIN}`;
	writeFileSync(f.replacement, prompt);
	writeFileSync(f.artifact, JSON.stringify({ ...f.approval, replacementPromptSha256: sha(prompt) }));
	await expect(reconcileCodexAgents(f.args, f.opts)).rejects.toThrow('PROMPT_SCOPE_CONFLICT');
	expect(readFileSync(f.file, 'utf8')).toBe(f.original);
});

it('rejects missing owner approval, malformed markers, and a known different identity in same directory', async () => {
	const f = fixture();
	writeFileSync(f.artifact, JSON.stringify({ ...f.approval, approvedControlledTestDirectory: false }));
	await expect(reconcileCodexAgents(f.args, f.opts)).rejects.toThrow('approval artifact');
	writeFileSync(f.artifact, JSON.stringify({ ...f.approval, approvedControlledTestDirectory: true, approvedOwnedBlock: false }));
	await expect(reconcileCodexAgents(f.args, f.opts)).rejects.toThrow('approval artifact');
	writeFileSync(f.artifact, JSON.stringify(f.approval));
	const malformed = f.original + AICHAT_SYSTEM_BEGIN + AICHAT_SYSTEM_END;
	writeFileSync(f.file, malformed);
	await expect(reconcileCodexAgents(f.args, f.opts)).rejects.toThrow('PROMPT_SCOPE_CONFLICT');
	writeFileSync(f.file, f.original);
	const other = new ConversationStore({ home: f.home, serverNamespace: f.opts.serverNamespace,
		activeUids: new Set(['42', '99']), activeProviders: new Map([['42', 'codex'], ['99', 'codex']]) });
	other.registerNative('codex', 'other-thread', '99', 'group', { threadId: 'other-thread', workspace: f.folder });
	other.close();
	await expect(reconcileCodexAgents(f.args, f.opts)).rejects.toThrow('another Codex conversation');
	expect(readFileSync(f.file, 'utf8')).toBe(f.original);
});

it('rejects a second room of the same identity sharing the approved directory', async () => {
	const f = fixture();
	const store = new ConversationStore({ home: f.home, serverNamespace: f.opts.serverNamespace,
		activeUids: new Set(['42']), activeProviders: new Map([['42', 'codex']]) });
	store.registerNative('codex', 'another-room-thread', '42', 'other-room', { threadId: 'another-room-thread', workspace: f.folder });
	store.close();
	await expect(reconcileCodexAgents(f.args, f.opts)).rejects.toThrow('another Codex conversation');
	expect(readFileSync(f.file, 'utf8')).toBe(f.original);
});

it('rejects a concurrent file change after backup without overwriting it', async () => {
	const f = fixture();
	const changed = 'someone changed this file';
	await expect(reconcileCodexAgents(f.args, { ...f.opts, beforeCommit: () => writeFileSync(f.file, changed) }))
		.rejects.toThrow('PROMPT_SCOPE_CONFLICT');
	expect(readFileSync(f.file, 'utf8')).toBe(changed);
	expect(readFileSync(join(f.home, 'codex', 'agent-block-backups', `${sha(f.original)}.bak`), 'utf8')).toBe(f.original);
});
