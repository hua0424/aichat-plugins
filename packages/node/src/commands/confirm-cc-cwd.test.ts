import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore } from '../capability/conversations.js';
import { confirmCcCwd } from './confirm-cc-cwd.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('requires an exact external owner artifact and offline lease, preserves original session and audit, rejects conflicts', async () => {
	const home = mkdtempSync(join(tmpdir(), 'aichat-confirm-cc-')); dirs.push(home);
	const opts = { home, serverNamespace: 'http://example.test',
		socketPath: process.platform === 'win32' ? `\\\\.\\pipe\\aichat-confirm-cc-${process.pid}-${Date.now()}` : join(home, 'capability.sock') };
	const store = new ConversationStore({ home, serverNamespace: opts.serverNamespace, activeUids: new Set(['1']), activeProviders: new Map([['1', 'cc']]) });
	store.registerNative('cc', 'old-id', '1', 'room', { sessionId: 'old-id' });
	store.close();
	const original = join(home, 'original');
	const approval = join(home, 'approval.json');
	const artifact = { owner: 'product-owner', approvalRef: 'https://github.com/example/issue/1#issuecomment-2',
		uid: '1', room: 'room', sessionId: 'old-id', generation: 1, originalCwd: original, approvedOriginalCwd: true };
	writeFileSync(approval, JSON.stringify(artifact));
	const args = ['1', 'room', 'old-id', '1', original, approval];
	const snapshot = join(home, 'conversations.json');
	const before = readFileSync(snapshot, 'utf8');
	await expect(confirmCcCwd(['1', 'other', ...args.slice(2)], opts)).rejects.toThrow('artifact');
	writeFileSync(join(home, 'conversation-writer.lock'), 'someone else');
	await expect(confirmCcCwd(args, opts)).rejects.toThrow();
	expect(readFileSync(snapshot, 'utf8')).toBe(before);
	rmSync(join(home, 'conversation-writer.lock'));
	await confirmCcCwd(args, opts);
	expect(existsSync(join(home, 'conversation-writer.lock'))).toBe(false);
	const after = new ConversationStore({ home, serverNamespace: opts.serverNamespace, activeUids: new Set(['1']), activeProviders: new Map([['1', 'cc']]) });
	expect(after.get('1', 'room')).toMatchObject({ state: 'ready', nativeState: { cc: { sessionId: 'old-id', workspace: original } },
		ccCwdConfirmation: { approvalRef: artifact.approvalRef, cwd: original } });
	const confirmedBytes = readFileSync(snapshot, 'utf8');
	await confirmCcCwd(args, opts);
	expect(readFileSync(snapshot, 'utf8')).toBe(confirmedBytes);
	await expect(confirmCcCwd(['1', 'room', 'old-id', '1', join(home, 'different'), approval], opts)).rejects.toThrow('artifact');
	expect(readFileSync(snapshot, 'utf8')).toBe(confirmedBytes);
});
