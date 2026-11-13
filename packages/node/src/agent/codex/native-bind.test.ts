import { afterEach, describe, expect, it, vi } from 'vitest';
import { CapabilityEndpoint } from '../../capability/endpoint.js';
import { CapabilityRegistry, sendMessageCapability } from '../../capability/registry.js';
import type { HulaApiClient } from '../../api/hula-api.js';
import { handleSendMessage } from '../../commands/send-message.js';
import { postCapability } from '../../capability/client.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore, type ConversationRecord } from '../../capability/conversations.js';
vi.mock('../../capability/client.js', () => ({ postCapability: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function endpoint() {
	const delivered: unknown[] = [];
	const apiClient = { async supportsMessageReceipts() { return false; }, async sendMessage(...args: unknown[]) { delivered.push(args); return { msgId: '72' }; } } as unknown as HulaApiClient;
	const registry = new CapabilityRegistry();
	registry.register('send-message', sendMessageCapability());
	const resolved = { aiclawUid: 'owner', roomId: 'trusted-room', conversationId: 'conversation', generation: 3, apiClient, replyBindingRequired: true };
	const server = new CapabilityEndpoint({ registry, serverNamespace: 'server', resolve: () => resolved, resolveCandidate: () => resolved,
		resolveReplyBinding: (token) => token === 'fixed-token' ? { token, runId: 'run-3', conversationId: 'conversation', generation: 3, serverNamespace: 'server', thinkingId: 'thinking-3' } : undefined });
	return { server, delivered };
}
function env(marker: boolean, token?: string) {
	for (const key of ['AICHAT_CONTEXT_KEY', 'OPENCODE_SESSION_ID', 'OPENCLAW_BIND', 'AICHAT_BIND', 'DSH_SESSION_ID']) vi.stubEnv(key, '');
	vi.stubEnv('CODEX_THREAD_ID', 'native-thread');
	vi.stubEnv('AICHAT_RUN_BIND', token ?? '');
	vi.stubEnv('AICHAT_CODEX_NATIVE', marker ? '1' : '');
}

describe('persistent Codex reply binding fail-closed boundary', () => {
	it('persists the strict fence across native reset, old leased aliases, legacy reset and restart', async () => {
		const home = await mkdtemp(join(tmpdir(), 'aichat-codex-fence-'));
		const options = { home, serverNamespace: 'server', activeUids: new Set(['owner']), activeProviders: new Map([['owner', 'codex']]) };
		let store = new ConversationStore(options);
		try {
			const delivered: unknown[] = [];
			const apiClient = { async supportsMessageReceipts() { return false; }, async sendMessage(...args: unknown[]) { delivered.push(args); return { msgId: '72' }; } } as unknown as HulaApiClient;
			const registry = new CapabilityRegistry(); registry.register('send-message', sendMessageCapability());
			const bound = (r: ConversationRecord | undefined) => r ? { aiclawUid: r.identityId, roomId: r.roomId,
				conversationId: r.conversationId, generation: r.generation, replyBindingRequired: r.replyBindingRequired, apiClient } : undefined;
			const server = new CapabilityEndpoint({ registry, serverNamespace: 'server', resolve: (key) => bound(store.resolveLegacy(key)),
				resolveCandidate: (candidate) => bound(store.resolveCandidate(candidate)), resolveReplyContext: (token, candidates) => bound(store.resolveReplyContext(token, candidates)),
				resolveReplyBinding: (token) => { const b = store.resolveReplyBinding(token); return b?.thinkingId ? { ...b, thinkingId: b.thinkingId } : undefined; } });
			const state = (threadId: string) => ({ threadId, workspace: home, promptHash: 'a'.repeat(64) });
			store.registerNative('codex', 'old', 'owner', 'trusted-room', { ...state('old'), nativeControls: true });
			// The still-shipped SDK and migration writers replace the entire state without nativeControls.
			store.registerNative('codex', 'old', 'owner', 'trusted-room', state('old'));
			expect(store.get('owner', 'trusted-room')?.replyBindingRequired).toBe(true);
			const old = store.beginRun('owner', 'trusted-room', 'old-run', { authorizationEpoch: 'epoch', nativeTurn: { sessionId: 'old', turnId: 'old-turn' } });
			old.saveNativeState('codex', state('old'));
			expect(store.get('owner', 'trusted-room')?.replyBindingRequired).toBe(true);
			store.confirmReplyBindingThinking('old-run', 'old-thinking');
			const next = store.replaceNativeSession('owner', 'trusted-room', old.generation, 'codex', 'new', state('new'));
			expect(next.replyBindingRequired).toBe(true); // state no longer contains nativeControls
			expect(() => old.assertCurrent()).toThrow('STALE_GENERATION');
			store.close(); store = new ConversationStore(options);
			for (const contexts of [[{ provider: 'codex', nativeId: 'old' }], [{ provider: 'codex', nativeId: 'new' }], [{ key: next.contextKey }]]) {
				const response = await server.handle({ body: { version: 2, contexts, command: 'send-message', requestId: 'no-grant', args: { content: 'wrong' } } });
				expect(response.status).not.toBe(200);
			}
			const exactOld = await server.handle({ body: { version: 3, contexts: [{ provider: 'codex', nativeId: 'old' }], runBinding: old.replyToken,
				command: 'send-message', requestId: 'old-reply', args: { content: 'old-only' } } });
			expect(exactOld.status).toBe(200);
			expect(delivered).toEqual([['trusted-room', 'old-only', { thinkingId: 'old-thinking' }]]);
			store.finishRun('old-run');
			const reset = store.reset('owner', 'trusted-room');
			expect(reset.nativeState).toEqual({}); expect(reset.replyBindingRequired).toBe(true);
			store.close(); store = new ConversationStore(options);
			const response = await server.handle({ body: { version: 2, contexts: [{ key: reset.contextKey }], command: 'send-message', requestId: 'no-grant-2', args: { content: 'wrong' } } });
			expect(response).toMatchObject({ status: 403, json: { code: 'RUN_BINDING_REQUIRED' } });
			expect(delivered).toHaveLength(1);
		} finally { store.close(); await rm(home, { recursive: true, force: true }); }
	});
	it('core rejects V1/V2 native and key alias sends independent of the environment marker', async () => {
		const f = endpoint();
		for (const routing of [{ version: 2, contexts: [{ provider: 'codex', nativeId: 'native-thread' }] },
			{ version: 2, contexts: [{ key: 'old-key' }] }, { sessionKey: 'codex:native-thread' }]) {
			expect(await f.server.handle({ body: { ...routing, command: 'send-message', requestId: 'write', args: { content: 'reply' } } }))
				.toMatchObject({ status: 403, json: { code: 'RUN_BINDING_REQUIRED', retryable: false } });
		}
		expect(f.delivered).toEqual([]);
	});
	it('the managed CLI refuses missing grants locally, and clearing its marker still cannot downgrade at core', async () => {
		const f = endpoint();
		vi.mocked(postCapability).mockImplementation(async (_path, body) => { const response = await f.server.handle({ body }); return { status: response.status, body: response.json }; });
		const out = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('cli exit'); });
		env(true);
		await expect(handleSendMessage(['--content', 'reply', '--json'])).rejects.toThrow('cli exit');
		expect(out.mock.calls.at(-1)?.[0]).toContain('RUN_BINDING_REQUIRED');
		env(false);
		await expect(handleSendMessage(['--content', 'reply', '--json'])).rejects.toThrow('cli exit');
		expect(out.mock.calls.at(-1)?.[0]).toContain('RUN_BINDING_REQUIRED');
		expect(f.delivered).toEqual([]);
	});
	it('only the exact V3 token targets the verified thinkingId; stale token cannot fall back', async () => {
		const f = endpoint();
		vi.mocked(postCapability).mockImplementation(async (_path, body) => { const response = await f.server.handle({ body }); return { status: response.status, body: response.json }; });
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('cli exit'); });
		env(true, 'stale-token');
		await expect(handleSendMessage(['--content', 'wrong', '--json'])).rejects.toThrow('cli exit');
		expect(f.delivered).toEqual([]);
		env(true, 'fixed-token');
		await handleSendMessage(['--content', 'exact', '--json']);
		expect(f.delivered).toEqual([['trusted-room', 'exact', { thinkingId: 'thinking-3' }]]);
	});
});
