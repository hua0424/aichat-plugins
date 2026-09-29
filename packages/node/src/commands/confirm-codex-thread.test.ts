import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore } from '../capability/conversations.js';
import { confirmCodexThread } from './confirm-codex-thread.js';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('requires one owner artifact binding exact original prompt/cwd, offline exclusive lease and idempotent audit', async () => {
	const home = mkdtempSync(join(tmpdir(), 'aichat-confirm-codex-')); dirs.push(home);
	const opts = { home, serverNamespace: 'http://example.test',
		socketPath: process.platform === 'win32' ? `\\\\.\\pipe\\aichat-confirm-codex-${process.pid}-${Date.now()}` : join(home, 'capability.sock') };
	mkdirSync(join(home, 'codex'));
	writeFileSync(join(home, 'codex', 'sessions.json'), JSON.stringify({ 'aiclaw-1-room-9': { threadId: 'old-thread' } }));
	const store = new ConversationStore({ home, serverNamespace: opts.serverNamespace, activeUids: new Set(['1']), activeProviders: new Map([['1', 'codex']]) });
	store.close();
	const cwd = join(home, 'original'), file = join(home, 'approval.json'), originalPrompt = 'exact original prompt\nline 2';
	const artifact = { owner: 'product-owner', approvalRef: 'https://github.com/example/issue/1#issuecomment-2', uid: '1', room: '9',
		threadId: 'old-thread', generation: 1, originalCwd: cwd, originalPrompt,
		originalPromptSha256: createHash('sha256').update(originalPrompt).digest('hex'), approvedOriginalThread: true };
	writeFileSync(file, JSON.stringify(artifact));
	const args = ['1', '9', 'old-thread', '1', cwd, file], snapshot = join(home, 'conversations.json');
	const before = readFileSync(snapshot, 'utf8');
	await expect(confirmCodexThread(['1', 'wrong', ...args.slice(2)], opts)).rejects.toThrow('artifact');
	writeFileSync(join(home, 'conversation-writer.lock'), 'other writer');
	await expect(confirmCodexThread(args, opts)).rejects.toThrow();
	expect(readFileSync(snapshot, 'utf8')).toBe(before);
	rmSync(join(home, 'conversation-writer.lock'));
	const log = vi.spyOn(console, 'log').mockImplementation(() => {});
	await confirmCodexThread(args, opts);
	expect(existsSync(join(home, 'conversation-writer.lock'))).toBe(false);
	const confirmed = readFileSync(snapshot, 'utf8');
	expect(confirmed).toContain(originalPrompt.replace('\n', '\\n'));
	expect(log.mock.calls.flat().join(' ')).not.toContain(originalPrompt);
	const reopened = new ConversationStore({ home, serverNamespace: opts.serverNamespace, activeUids: new Set(['1']), activeProviders: new Map([['1', 'codex']]) });
	expect(reopened.get('1', '9')).toMatchObject({ state: 'ready', nativeState: { codex: { threadId: 'old-thread', workspace: cwd,
		originalPrompt, promptHash: artifact.originalPromptSha256 } }, codexThreadConfirmation: {
		artifactSha256: createHash('sha256').update(JSON.stringify(artifact)).digest('hex'), approvalRef: artifact.approvalRef } });
	reopened.close();
	await confirmCodexThread(args, opts);
	expect(readFileSync(snapshot, 'utf8')).toBe(confirmed);
	writeFileSync(file, JSON.stringify({ ...artifact, originalPrompt: 'changed' }));
	await expect(confirmCodexThread(args, opts)).rejects.toThrow('artifact');
	expect(readFileSync(snapshot, 'utf8')).toBe(confirmed);
});

it('accepts explicitly approved empty frozen prompt with SHA-256(empty), retaining it across restart', async () => {
	const home = mkdtempSync(join(tmpdir(), 'aichat-confirm-codex-empty-')); dirs.push(home);
	const opts = { home, serverNamespace: 'http://example.test',
		socketPath: process.platform === 'win32' ? `\\\\.\\pipe\\aichat-confirm-codex-empty-${process.pid}-${Date.now()}` : join(home, 'capability.sock') };
	mkdirSync(join(home, 'codex'));
	writeFileSync(join(home, 'codex', 'sessions.json'), JSON.stringify({ 'aiclaw-1-room-9': { threadId: 'old-thread' } }));
	new ConversationStore({ home, serverNamespace: opts.serverNamespace, activeUids: new Set(['1']), activeProviders: new Map([['1', 'codex']]) }).close();
	const cwd = join(home, 'original'), file = join(home, 'approval.json'), emptyHash = createHash('sha256').update('').digest('hex');
	const artifact = { owner: 'product-owner', approvalRef: 'https://github.com/example/issue/1#issuecomment-2', uid: '1', room: '9',
		threadId: 'old-thread', generation: 1, originalCwd: cwd, originalPrompt: '',
		originalPromptSha256: emptyHash, approvedOriginalThread: true };
	writeFileSync(file, JSON.stringify(artifact));
	vi.spyOn(console, 'log').mockImplementation(() => {});
	await confirmCodexThread(['1', '9', 'old-thread', '1', cwd, file], opts);
	const reopened = new ConversationStore({ home, serverNamespace: opts.serverNamespace, activeUids: new Set(['1']), activeProviders: new Map([['1', 'codex']]) });
	expect(reopened.get('1', '9')).toMatchObject({ state: 'ready', nativeState: { codex: { threadId: 'old-thread',
		workspace: cwd, originalPrompt: '', promptHash: emptyHash, legacyConfirmationRequired: false } },
		codexThreadConfirmation: { promptHash: emptyHash, artifactSha256: createHash('sha256').update(JSON.stringify(artifact)).digest('hex') } });
	reopened.close();
	await confirmCodexThread(['1', '9', 'old-thread', '1', cwd, file], opts);
});
