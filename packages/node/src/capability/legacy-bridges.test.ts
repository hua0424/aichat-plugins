import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore } from './conversations.js';
import { legacyBridges } from './legacy-bridges.js';

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

/** The same store serves real driver interfaces and both legacy/V2 endpoint locators. */
describe('legacy driver bridge', () => {
	it('persists native creation, replacement and stable CC token without touching old files', () => {
		const home = mkdtempSync(join(tmpdir(), 'aichat-bridge-'));
		homes.push(home);
		writeFileSync(join(home, 'bind-tokens.json'), '{}');
		const opts = { home, serverNamespace: 'test-server', activeUids: new Set(['1', '2']),
			activeProviders: new Map([['1', 'cc'], ['2', 'codex']] as const) };
		const store = new ConversationStore(opts);
		const bridges = legacyBridges(() => store);
		const first = bridges.bindTokens.mint('1', '42');
		expect(bridges.bindTokens.resolve(first)).toEqual({ aiclawUid: '1', roomId: '42' });
		bridges.cc.set('aiclaw-1-room-42', { sessionId: 'session-1' });
		expect(bridges.cc.get('aiclaw-1-room-42')).toEqual({ sessionId: 'session-1' });
		bridges.cc.delete('aiclaw-1-room-42');
		expect(bridges.bindTokens.mint('1', '42')).toBe(first);
		const key = store.contextKey('2', '43');
		bridges.codex.set('aiclaw-2-room-43', { threadId: 'thread-1' });
		expect(store.resolveCandidates([{ key }, { provider: 'codex', nativeId: 'thread-1' }])?.roomId).toBe('43');
		bridges.codex.set('aiclaw-2-room-43', { threadId: 'thread-2' });
		expect(bridges.codex.findKeyByThreadId('thread-1')).toBeUndefined();
		expect(bridges.codex.findKeyByThreadId('thread-2')).toBe('aiclaw-2-room-43');
		expect(new ConversationStore(opts).getNative('codex', '2', '43')).toEqual({ threadId: 'thread-2' });
		expect(readFileSync(join(home, 'bind-tokens.json'), 'utf8')).toBe('{}');
	});
});
