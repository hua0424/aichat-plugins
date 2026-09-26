import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore } from './conversations.js';
import { legacyBridges, withLegacyNativeScope } from './legacy-bridges.js';
import { LegacyDriverBridge } from '../agent/legacy-run.js';
import type { AgentDriver, AgentEvent, PreparedRun } from '../agent/events.js';

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

	it('rejects late native writes from openSession/send async tasks after reset and manual recovery', async () => {
		const home = mkdtempSync(join(tmpdir(), 'aichat-bridge-scope-'));
		homes.push(home);
		const store = new ConversationStore({ home, serverNamespace: 'test-server', activeUids: new Set(['1']), activeProviders: new Map([['1', 'cc']]) });
		const bridges = legacyBridges(() => store);
		const key = 'aiclaw-1-room-42';
		const bound = store.beginRun('1', '42', 'old');
		const scope = { identityId: '1', roomId: '42', conversationId: bound.conversationId, generation: bound.generation };
		const failures: string[] = [];
		const pending: Promise<void>[] = [];
		let releaseOpen!: () => void;
		let releaseSend!: () => void;
		const later = (release: (fn: () => void) => void, op: () => void) => {
			const gate = new Promise<void>((resolve) => release(resolve));
			pending.push(gate.then(() => { try { op(); } catch (error) { failures.push((error as Error).message); } }));
		};
		const driver: AgentDriver = {
			type: 'cc', connect: async () => {}, disconnect: async () => {},
			openSession: async () => {
				later((resolve) => { releaseOpen = resolve; }, () => {
					bridges.cc.set(key, { sessionId: 'late-open' });
				});
				return {
					close: async () => {},
					send: () => ({ async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
						later((resolve) => { releaseSend = resolve; }, () => {
							bridges.cc.delete(key);
						});
						yield { type: 'done', durationMs: 1 };
					} }),
				};
			},
		};
		const input: PreparedRun = {
			runId: 'old', message: 'hello', systemPrompt: '', signal: new AbortController().signal,
			conversation: { id: bound.conversationId, generation: bound.generation, nativeState: undefined,
				assertCurrent: () => bound.assertCurrent(), saveNativeState: async () => {}, registerNativeAlias: async () => {} },
			saveRecovery: async (value) => bound.saveRecovery(value), capabilities: { invoke: async () => undefined },
		};
		const bridge = new LegacyDriverBridge(driver, () => ({ aiclawUid: '1', roomId: '42', chatContext: { roomId: '42', roomType: 1 } }), { nativeScope: scope });
		const events: AgentEvent[] = [];
		for await (const event of bridge.createRun(input).events) events.push(event);
		expect(events).toEqual([{ type: 'done', durationMs: 1 }]);
		expect(releaseOpen).toBeTypeOf('function');
		expect(releaseSend).toBeTypeOf('function');
		// Same-generation writes remain legal; scope rejects a different room even before reset.
		withLegacyNativeScope(scope, () => {
			bridges.cc.set(key, { sessionId: 'same-gen' });
			expect(bridges.cc.get(key)).toEqual({ sessionId: 'same-gen' });
			expect(bridges.bindTokens.mint('1', '42')).toBeTypeOf('string');
			bridges.cc.delete(key);
			bridges.cc.set(key, { sessionId: 'same-gen' });
			expect(() => bridges.cc.delete('aiclaw-1-room-43')).toThrow('STALE_GENERATION');
		});
		store.reset('1', '42');
		store.confirmStopped('old'); // manual recovery reopens the new generation; the callback still exists
		const current = store.get('1', '42')!;
		withLegacyNativeScope({ identityId: '1', roomId: '42', conversationId: current.conversationId,
			generation: current.generation }, () => bridges.cc.set(key, { sessionId: 'new-gen' })); // new generation is ready
		releaseOpen();
		releaseSend();
		await Promise.all(pending);
		expect(failures).toEqual(['STALE_GENERATION', 'STALE_GENERATION']);
		expect(store.getNative('cc', '1', '42')).toEqual({ sessionId: 'new-gen' });
		expect(() => withLegacyNativeScope(scope, () => bridges.cc.get(key))).toThrow('STALE_GENERATION');
		expect(() => withLegacyNativeScope(scope, () => bridges.bindTokens.mint('1', '42'))).toThrow('STALE_GENERATION');
		store.close();
	});
});
