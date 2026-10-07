import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ConversationStore } from '../capability/conversations.js';
import { ccNativeHistoryFile, confirmCcCwd } from './confirm-cc-cwd.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('requires an exact external owner artifact and offline lease, preserves original session and audit, rejects conflicts', async () => {
	const home = mkdtempSync(join(tmpdir(), 'aichat-confirm-cc-')); dirs.push(home);
	const opts = { home, serverNamespace: 'http://example.test',
		socketPath: process.platform === 'win32' ? `\\\\.\\pipe\\aichat-confirm-cc-${process.pid}-${Date.now()}` : join(home, 'capability.sock'),
		ccConfigDir: join(home, 'claude') };
	const storeOptions = { home, serverNamespace: opts.serverNamespace, activeUids: new Set(['1']), activeProviders: new Map([['1', 'cc']]) };
	// #343: 挂起态用真实旧迁移接缝播种（cc/sessions.json 只有 sessionId）。
	mkdirSync(join(home, 'cc'), { recursive: true });
	writeFileSync(join(home, 'cc', 'sessions.json'), JSON.stringify({ 'aiclaw-1-room-9': { sessionId: 'old-id' } }));
	const store = new ConversationStore(storeOptions);
	expect(store.get('1', '9')?.state).toBe('suspended');
	store.close();
	const original = join(home, 'original');
	const approval = join(home, 'approval.json');
	const artifact = { owner: 'product-owner', approvalRef: 'https://github.com/example/issue/1#issuecomment-2',
		uid: '1', room: '9', sessionId: 'old-id', generation: 1, originalCwd: original, approvedOriginalCwd: true };
	writeFileSync(approval, JSON.stringify(artifact));
	const args = ['1', '9', 'old-id', '1', original, approval];
	const snapshot = join(home, 'conversations.json');
	const before = readFileSync(snapshot, 'utf8');
	await expect(confirmCcCwd(['1', 'other', ...args.slice(2)], opts)).rejects.toThrow('artifact');
	// #343: 目录或原生历史缺失时必须整体拒绝，不解除暂停（缺历史=owner 的 reset 决策）。
	mkdirSync(original, { recursive: true });
	await expect(confirmCcCwd(args, opts)).rejects.toThrow('native CC history');
	expect(readFileSync(snapshot, 'utf8')).toBe(before);
	const historyFile = ccNativeHistoryFile(opts.ccConfigDir!, original, 'old-id');
	mkdirSync(dirname(historyFile), { recursive: true });
	writeFileSync(historyFile, '{"session":true}\n');
	writeFileSync(join(home, 'conversation-writer.lock'), 'someone else');
	await expect(confirmCcCwd(args, opts)).rejects.toThrow();
	expect(readFileSync(snapshot, 'utf8')).toBe(before);
	rmSync(join(home, 'conversation-writer.lock'));
	await confirmCcCwd(args, opts);
	expect(existsSync(join(home, 'conversation-writer.lock'))).toBe(false);
	const after = new ConversationStore(storeOptions);
	expect(after.get('1', '9')).toMatchObject({ state: 'ready', nativeState: { cc: { sessionId: 'old-id', workspace: original } },
		ccCwdConfirmation: { approvalRef: artifact.approvalRef, cwd: original } });
	const confirmedBytes = readFileSync(snapshot, 'utf8');
	await confirmCcCwd(args, opts);
	expect(readFileSync(snapshot, 'utf8')).toBe(confirmedBytes);
	await expect(confirmCcCwd(['1', '9', 'old-id', '1', join(home, 'different'), approval], opts)).rejects.toThrow('artifact');
	expect(readFileSync(snapshot, 'utf8')).toBe(confirmedBytes);
});

it('#343: maps the deployed CC native-history layout <projects>/<cwd-slug>/<sessionId>.jsonl', () => {
	const file = ccNativeHistoryFile('/root/.claude', '/workspace', 'session-1');
	expect(file).toBe(join('/root/.claude', 'projects', '-workspace', 'session-1.jsonl'));
});
