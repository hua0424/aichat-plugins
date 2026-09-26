import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { HulaApiClient } from '../api/hula-api.js';
import { handleSendMessage } from '../commands/send-message.js';
import { CapabilityEndpoint } from './endpoint.js';
import { CapabilityRegistry, sendMessageCapability } from './registry.js';
import { ConversationStore, type Provider } from './conversations.js';
import { legacyBridges } from './legacy-bridges.js';
import { postCapability } from './client.js';

/** Exercises actual CLI→IPC→core→capability routing, not a resolver stub. Upstream agent and HuLa E2E remain separate. */
describe('four driver legacy bridges through real capability endpoint', () => {
	const saved = Object.fromEntries(['AICHAT_CAPABILITY_SOCK', 'AICHAT_CONTEXT_KEY', 'OPENCLAW_BIND', 'AICHAT_BIND', 'CODEX_THREAD_ID', 'OPENCODE_SESSION_ID']
		.map((name) => [name, process.env[name]]));
	let home: string | undefined;
	let endpoint: CapabilityEndpoint | undefined;
	afterEach(async () => {
		await endpoint?.close(); endpoint = undefined;
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name]; else process.env[name] = value;
		}
		if (home) rmSync(home, { force: true, recursive: true }); home = undefined;
		vi.restoreAllMocks();
	});
	it('routes each real CLI request to its activated identity and room; rejects inherited conflicting candidates', async () => {
		home = mkdtempSync(join(tmpdir(), 'aichat-real-registry-'));
		const providers = new Map<string, Provider>([['1', 'openclaw'], ['2', 'cc'], ['3', 'codex'], ['4', 'opencode']]);
		const options = { home, serverNamespace: 'isolated-test', activeUids: new Set(providers.keys()), activeProviders: providers };
		const store = new ConversationStore(options), bridges = legacyBridges(() => store);
		const openclaw = bridges.bindTokens.mint('1', '101'), cc = bridges.bindTokens.mint('2', '202');
		bridges.codex.set('aiclaw-3-room-303', { threadId: 'thread-303' });
		bridges.opencode.set('aiclaw-4-room-404', { sessionID: 'session-404', directory: '/test' });
		const written: string[] = [];
		const api = (uid: string) => ({ sendMessage: async (room: string) => {
			written.push(`${uid}:${room}`); return { msgId: randomUUID() };
		} }) as unknown as HulaApiClient;
		const apis = new Map([...providers.keys()].map((uid) => [uid, api(uid)]));
		const bound = (r: ReturnType<typeof store.resolveCandidate>) => r && ({
			aiclawUid: r.identityId, roomId: r.roomId, conversationId: r.conversationId,
			generation: r.generation, apiClient: apis.get(r.identityId)!,
		});
		const registry = new CapabilityRegistry(); registry.register('send-message', sendMessageCapability());
		endpoint = new CapabilityEndpoint({ registry,
			resolve: (key) => bound(store.resolveLegacy(key)),
			resolveCandidate: (candidate) => bound(store.resolveCandidate(candidate as Parameters<typeof store.resolveCandidate>[0])),
		});
		const socket = process.platform === 'win32' ? `\\\\.\\pipe\\aichat-real-${randomUUID()}` : join(home, 'capability.sock');
		process.env.AICHAT_CAPABILITY_SOCK = socket;
		await endpoint.listen(socket);
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		for (const [name, value] of [
			['OPENCLAW_BIND', openclaw], ['AICHAT_BIND', cc], ['CODEX_THREAD_ID', 'thread-303'],
			['OPENCODE_SESSION_ID', 'session-404'],
		]) {
			for (const candidate of ['OPENCLAW_BIND', 'AICHAT_BIND', 'CODEX_THREAD_ID', 'OPENCODE_SESSION_ID']) delete process.env[candidate];
			process.env[name] = value;
			await handleSendMessage(['--content', 'real IPC bridge']);
		}
		expect(written).toEqual(['1:101', '2:202', '3:303', '4:404']);
		process.env.CODEX_THREAD_ID = 'thread-303';
		const rejected = await postCapability(socket, { version: 2, contexts: [
			{ provider: 'opencode', nativeId: 'session-404' }, { provider: 'codex', nativeId: 'thread-303' },
		], command: 'send-message', args: { content: 'wrong room' }, requestId: randomUUID() });
		expect(rejected.status).toBe(409);
		expect(written).toHaveLength(4);
		await endpoint.close(); endpoint = undefined;
		const resumed = new ConversationStore(options);
		expect(resumed.resolveLegacy(`openclaw:${openclaw}`)?.roomId).toBe('101');
		expect(resumed.resolveLegacy('codex:thread-303')?.roomId).toBe('303');
	});
});
