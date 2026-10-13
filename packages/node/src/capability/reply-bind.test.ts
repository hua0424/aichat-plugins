import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HulaApiClient } from '../api/hula-api.js';
import { CapabilityEndpoint } from './endpoint.js';
import { CapabilityRegistry, sendMessageCapability } from './registry.js';
import { ConversationStore, REPLY_BINDING_TTL_MS, REPLY_BINDING_MAX_LIVE_PER_CONVERSATION } from './conversations.js';

const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
	vi.restoreAllMocks();
});
const home = () => { const h = mkdtempSync(join(tmpdir(), 'reply-bind-')); homes.push(h); return h; };
const store = (h: string) => new ConversationStore({ home: h, serverNamespace: 'test-ns', activeUids: new Set(['7']) });

/** #404: locked implementation constants — lease covers a normal run + the 7d requestId window. */
describe('reply binding lease + capacity constants', () => {
	it('locks 8d lease and explicit bounded capacity', () => {
		expect(REPLY_BINDING_TTL_MS).toBe(8 * 24 * 60 * 60 * 1000);
		expect(REPLY_BINDING_MAX_LIVE_PER_CONVERSATION).toBe(1024);
	});
});

describe('ConversationStore reply bindings', () => {
	it('mints an opaque 64-hex token at beginRun and persists it before the caller sees it', () => {
		const h = home();
		const s = store(h);
		const bound = s.beginRun('7', '42', 'run-A');
		expect(bound.replyToken).toMatch(/^[0-9a-f]{64}$/);
		// A second store on the same home sees the binding (persisted, not memory-only),
		// but it is unfixed and therefore unresolvable.
		const reloaded = store(h);
		expect(reloaded.resolveReplyBinding(bound.replyToken)).toBeUndefined();
		expect(reloaded.get('7', '42')?.replyBindings).toHaveLength(1);
		s.close(); reloaded.close();
	});

	it('fixes thinkingId exactly once; same-ID repeat is idempotent, conflict is refused', () => {
		const h = home();
		const s = store(h);
		const bound = s.beginRun('7', '42', 'run-A');
		expect(s.confirmReplyBindingThinking('run-A', '555')).toMatchObject({ runId: 'run-A', thinkingId: '555' });
		expect(s.confirmReplyBindingThinking('run-A', '555')).toMatchObject({ thinkingId: '555' });
		expect(() => s.confirmReplyBindingThinking('run-A', '556')).toThrow('conflicting START receipt');
		expect(s.resolveReplyBinding(bound.replyToken)).toMatchObject({
			runId: 'run-A', thinkingId: '555', generation: 1, serverNamespace: 'test-ns' });
		s.close();
	});

	it('refuses confirmation for unknown, released, or cross-run targets', () => {
		const h = home();
		const s = store(h);
		expect(() => s.confirmReplyBindingThinking('nope', '1')).toThrow('run no longer pending');
		const a = s.beginRun('7', '42', 'run-A');
		s.finishRun('run-A');
		expect(() => s.confirmReplyBindingThinking('run-A', '1')).toThrow('run no longer pending');
		// The released binding keeps no fixed target: late frames cannot adopt one.
		expect(s.resolveReplyBinding(a.replyToken)).toBeUndefined();
		expect(() => s.confirmReplyBindingThinking('run-A', '')).toThrow();
		s.close();
	});

	it('finishRun keeps the fixed binding usable; reset revokes it', () => {
		const h = home();
		const s = store(h);
		const a = s.beginRun('7', '42', 'run-A');
		s.confirmReplyBindingThinking('run-A', '555');
		s.finishRun('run-A');
		// END-after-A may still associate to A while the authorization lives.
		expect(s.resolveReplyBinding(a.replyToken)).toMatchObject({ thinkingId: '555' });
		s.reset('7', '42');
		expect(s.resolveReplyBinding(a.replyToken)).toBeUndefined();
		expect(s.get('7', '42')?.replyBindings).toEqual([]);
		s.close();
	});

	it('never evicts a live binding early; only expiry or superseded generations prune', () => {
		const h = home();
		const s = store(h);
		const tokens: string[] = [];
		for (let i = 0; i < 3; i++) {
			const runId = `run-${i}`;
			tokens.push(s.beginRun('7', '42', runId).replyToken);
			s.confirmReplyBindingThinking(runId, String(100 + i));
			s.finishRun(runId);
		}
		const fourth = s.beginRun('7', '42', 'run-3');
		for (const [i, token] of tokens.entries()) {
			expect(s.resolveReplyBinding(token)).toMatchObject({ thinkingId: String(100 + i) });
		}
		expect(s.get('7', '42')?.replyBindings).toHaveLength(4);
		s.finishRun('run-3');
		expect(fourth.replyToken).toMatch(/^[0-9a-f]{64}$/);
		s.close();
	});

	it('refuses a new run with explicit backpressure at full live capacity, never silent eviction', () => {
		const h = home();
		const s = store(h);
		s.beginRun('7', '42', 'seed');
		s.finishRun('seed');
		// Craft a full house of live bindings directly in the snapshot (1024 × beginRun would
		// also persist 1024 times); one entry is expired and must not count toward the cap.
		const path = join(h, 'conversations.json');
		const snapshot = JSON.parse(readFileSync(path, 'utf8')) as {
			records: Array<{ replyBindings: Array<Record<string, unknown>>; conversationId: string; generation: number }>;
		};
		const record = snapshot.records[0];
		const now = Date.now();
		record.replyBindings = [];
		for (let i = 0; i < REPLY_BINDING_MAX_LIVE_PER_CONVERSATION; i++) {
			record.replyBindings.push({ token: i.toString(16).padStart(64, '0'), runId: `old-${i}`,
				conversationId: record.conversationId, serverNamespace: 'test-ns', generation: record.generation,
				thinkingId: String(i), createdAt: new Date(now - 1000).toISOString(),
				expiresAt: new Date(now + REPLY_BINDING_TTL_MS).toISOString() });
		}
		record.replyBindings.push({ token: 'e'.repeat(64), runId: 'old-expired',
			conversationId: record.conversationId, serverNamespace: 'test-ns', generation: record.generation,
			createdAt: new Date(now - REPLY_BINDING_TTL_MS - 2000).toISOString(),
			expiresAt: new Date(now - 1000).toISOString() });
		writeFileSync(path, JSON.stringify(snapshot));
		const full = store(h);
		expect(() => full.beginRun('7', '42', 'one-too-many')).toThrow('reply binding capacity exceeded');
		// Nothing was evicted to make room: the live set is intact.
		expect(full.get('7', '42')?.replyBindings?.filter((b) => b.runId !== 'old-expired')).toHaveLength(
			REPLY_BINDING_MAX_LIVE_PER_CONVERSATION);
		s.close(); full.close();
	});

	it('expired bindings never resolve, even with a valid token', () => {
		const h = home();
		const s = store(h);
		const a = s.beginRun('7', '42', 'run-A');
		s.confirmReplyBindingThinking('run-A', '555');
		s.finishRun('run-A');
		const path = join(h, 'conversations.json');
		const snapshot = JSON.parse(readFileSync(path, 'utf8')) as {
			records: Array<{ replyBindings: Array<Record<string, unknown>> }>;
		};
		// Age the whole binding past its lease: createdAt far past, expiresAt = createdAt + TTL
		// (still > createdAt, so the snapshot stays valid) but already elapsed → unresolvable.
		const agedAt = new Date(Date.now() - REPLY_BINDING_TTL_MS - 2000).toISOString();
		snapshot.records[0].replyBindings[0].createdAt = agedAt;
		snapshot.records[0].replyBindings[0].expiresAt =
			new Date(Date.parse(agedAt) + REPLY_BINDING_TTL_MS).toISOString();
		writeFileSync(path, JSON.stringify(snapshot));
		const aged = store(h);
		expect(aged.resolveReplyBinding(a.replyToken)).toBeUndefined();
		s.close(); aged.close();
	});

	it('a disk failure during beginRun leaves no usable binding behind', () => {
		const h = home();
		const s = store(h);
		s.getOrCreate('7', '42');
		const failing = new ConversationStore({ home: h, serverNamespace: 'test-ns',
			activeUids: new Set(['7']), beforePersist: () => { throw new Error('disk gone'); } });
		expect(() => failing.beginRun('7', '42', 'run-A')).toThrow('disk gone');
		const after = store(h);
		expect(after.get('7', '42')?.pendingRuns).toBeUndefined();
		expect(after.get('7', '42')?.replyBindings ?? []).toEqual([]);
		s.close(); after.close();
	});
});

// --- endpoint + registry integration over a real store + a simulated receipt-capable server ---

const ok = (data: unknown): Response => ({ ok: true, json: async () => ({ success: true, data }) }) as Response;
const generatedId = () => `r${Date.now().toString(36)}.${randomUUID()}`;

function serverEmulator() {
	const posts: Array<Record<string, unknown>> = [];
	const receipts = new Map<string, { body: string; id: string }>();
	let nextId = 9007199254740993;
	const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
		if (String(url).endsWith('/receipt-capability')) return ok('requestId-v1;retention-min=7d');
		const body = JSON.parse(init?.body as string) as Record<string, unknown>;
		posts.push(body);
		// Server-side requestId dedup: same ID + same body → same msgId; same ID + other body → 43061.
		const prior = receipts.get(body.requestId as string);
		if (prior && prior.body !== (init?.body as string)) {
			return { ok: true, json: async () => ({ success: false, code: 43061, msg: 'conflict' }) } as Response;
		}
		if (!prior) {
			const id = String(nextId++);
			receipts.set(body.requestId as string, { body: init?.body as string, id });
		}
		return ok({ message: { id: receipts.get(body.requestId as string)!.id } });
	});
	return { posts, fetcher };
}

function liveEndpoint(s: ConversationStore, client: HulaApiClient, opts?: { resolveReplyBinding?: false }) {
	const registry = new CapabilityRegistry();
	registry.register('send-message', sendMessageCapability());
	const bound = (r: ReturnType<ConversationStore['resolveCandidate']>) => r && ({
		aiclawUid: r.identityId, roomId: r.roomId, apiClient: client,
		conversationId: r.conversationId, generation: r.generation });
	return new CapabilityEndpoint({ registry, resolve: () => undefined,
		resolveCandidate: (candidate) => bound(s.resolveCandidate(candidate)),
		...(opts?.resolveReplyBinding === false ? {} : { resolveReplyBinding: (token: string) => {
			const b = s.resolveReplyBinding(token);
			return b?.thinkingId === undefined ? undefined : { token: b.token, runId: b.runId,
				conversationId: b.conversationId, serverNamespace: b.serverNamespace,
				generation: b.generation, thinkingId: b.thinkingId };
		} }),
		serverNamespace: 'test-ns' });
}

function setupBound(room = '42') {
	const h = home();
	const s = store(h);
	const key = s.getOrCreate('7', room).contextKey;
	const bound = s.beginRun('7', room, `run-${room}`);
	s.confirmReplyBindingThinking(`run-${room}`, '555');
	s.finishRun(`run-${room}`);
	return { h, s, key, token: bound.replyToken };
}

/** Two rooms sharing one store (cross-conversation checks need a common core). */
function setupTwoRooms() {
	const h = home();
	const s = store(h);
	const keyA = s.getOrCreate('7', '42').contextKey;
	const keyB = s.getOrCreate('7', '43').contextKey;
	const a = s.beginRun('7', '42', 'run-A');
	s.confirmReplyBindingThinking('run-A', '555');
	s.finishRun('run-A');
	const b = s.beginRun('7', '43', 'run-B');
	s.confirmReplyBindingThinking('run-B', '777');
	s.finishRun('run-B');
	return { h, s, keyA, keyB, tokenA: a.replyToken, tokenB: b.replyToken };
}

describe('V3 run-bound send-message', () => {
	it('associates a fixed extra.thinkingId end to end; unassociated V2 carries none', async () => {
		const { s, key, token } = setupBound();
		const { posts } = serverEmulator();
		const client = new HulaApiClient('http://test', 'secret');
		const endpoint = liveEndpoint(s, client);
		const v3 = { version: 3, contexts: [{ key }], command: 'send-message',
			args: { content: 'hello' }, requestId: generatedId(), runBinding: token };
		const res = await endpoint.handle({ body: v3 });
		expect(res).toMatchObject({ status: 200, json: { result: { receiptMode: 'durable', thinkingId: '555' } } });
		expect(posts).toHaveLength(1);
		expect(posts[0]).toMatchObject({ extra: { cliGeneration: 1, thinkingId: '555' } });
		// Same room without a binding stays compatible but claims no association.
		const v2 = { version: 2, contexts: [{ key }], command: 'send-message',
			args: { content: 'plain' }, requestId: generatedId() };
		const plain = await endpoint.handle({ body: v2 });
		expect(plain).toMatchObject({ status: 200, json: { result: { receiptMode: 'durable' } } });
		expect(plain.json).not.toHaveProperty('result.thinkingId');
		expect(posts[1]).toMatchObject({ extra: { cliGeneration: 1 } });
		expect(posts[1]).not.toHaveProperty('extra.thinkingId');
		s.close();
	});

	it('rejects unknown/forged/unfixed bindings with zero business POST and no legacy downgrade', async () => {
		const { s, key } = setupBound();
		const { posts } = serverEmulator();
		const client = new HulaApiClient('http://test', 'secret');
		const endpoint = liveEndpoint(s, client);
		const unfixedRun = s.beginRun('7', '42', 'run-unfixed');
		const unfixed = unfixedRun.replyToken;
		s.finishRun('run-unfixed');
		for (const bad of ['0'.repeat(64), unfixed, 'x'.repeat(257)]) {
			const res = await endpoint.handle({ body: { version: 3, contexts: [{ key }],
				command: 'send-message', args: { content: 'hi' }, requestId: generatedId(), runBinding: bad } });
			expect([400, 403]).toContain(res.status);
			expect(res.json).toMatchObject({ ok: false });
		}
		// The one well-formed unfixed token must be an explicit binding refusal (not a downgrade).
		const refused = await endpoint.handle({ body: { version: 3, contexts: [{ key }],
			command: 'send-message', args: { content: 'hi' }, requestId: generatedId(), runBinding: unfixed } });
		expect(refused).toMatchObject({ status: 403, json: { code: 'FORBIDDEN' } });
		expect(posts).toHaveLength(0);
		expect(unfixed).toMatch(/^[0-9a-f]{64}$/);
		s.close();
	});

	it('rejects cross-conversation and stale-generation bindings without dispatch', async () => {
		const { s, keyA, keyB, tokenA } = setupTwoRooms();
		const { posts } = serverEmulator();
		const client = new HulaApiClient('http://test', 'secret');
		const endpoint = liveEndpoint(s, client);
		// Room 43's contexts with room 42's token: inconsistent → refused.
		expect(await endpoint.handle({ body: { version: 3, contexts: [{ key: keyB }],
			command: 'send-message', args: { content: 'hi' }, requestId: generatedId(), runBinding: tokenA } }))
			.toMatchObject({ status: 403, json: { code: 'FORBIDDEN' } });
		// Reset rotates the context key AND the generation: the old key is unknown, and even the
		// new key with the old token is stale → both refused, 0 new POST.
		s.reset('7', '42');
		expect(await endpoint.handle({ body: { version: 3, contexts: [{ key: keyA }],
			command: 'send-message', args: { content: 'hi' }, requestId: generatedId(), runBinding: tokenA } }))
			.toMatchObject({ status: 404, json: { code: 'UNKNOWN_CONTEXT' } });
		const freshKey = s.get('7', '42')!.contextKey;
		expect(await endpoint.handle({ body: { version: 3, contexts: [{ key: freshKey }],
			command: 'send-message', args: { content: 'hi' }, requestId: generatedId(), runBinding: tokenA } }))
			.toMatchObject({ status: 403, json: { code: 'FORBIDDEN' } });
		expect(posts).toHaveLength(0);
		s.close();
	});

	it('fails closed when the binding verifier is unwired', async () => {
		const { s, key, token } = setupBound();
		const { posts } = serverEmulator();
		const endpoint = liveEndpoint(s, new HulaApiClient('http://test', 'secret'), { resolveReplyBinding: false });
		expect(await endpoint.handle({ body: { version: 3, contexts: [{ key }],
			command: 'send-message', args: { content: 'hi' }, requestId: generatedId(), runBinding: token } }))
			.toMatchObject({ status: 400, json: { ok: false } });
		expect(posts).toHaveLength(0);
		s.close();
	});

	it('keeps same msgId/thinkingId on same-ID retry and refuses another run reusing the ID', async () => {
		const { s, key, token } = setupBound();
		const { posts } = serverEmulator();
		const client = new HulaApiClient('http://test', 'secret');
		const endpoint = liveEndpoint(s, client);
		const requestId = generatedId();
		const first = await endpoint.handle({ body: { version: 3, contexts: [{ key }],
			command: 'send-message', args: { content: 'same' }, requestId, runBinding: token } });
		expect(first.status).toBe(200);
		const second = await endpoint.handle({ body: { version: 3, contexts: [{ key }],
			command: 'send-message', args: { content: 'same' }, requestId, runBinding: token } });
		expect(second).toEqual(first);
		expect(posts).toHaveLength(1);
		// Run B presents A's requestId with its own fixed target → fingerprint conflict, refused.
		const b = s.beginRun('7', '42', 'run-B');
		s.confirmReplyBindingThinking('run-B', '777');
		const hijack = await endpoint.handle({ body: { version: 3, contexts: [{ key }],
			command: 'send-message', args: { content: 'same' }, requestId, runBinding: b.replyToken } });
		expect(hijack).toMatchObject({ status: 409, json: { code: 'IDEMPOTENCY_CONFLICT' } });
		expect(posts).toHaveLength(1);
		s.close();
	});

	it('re-verifies eligibility on post-commit reset attempts without changing the target', async () => {
		const { s, key, token } = setupBound();
		const { posts } = serverEmulator();
		const client = new HulaApiClient('http://test', 'secret');
		const endpoint = liveEndpoint(s, client);
		const requestId = generatedId();
		const first = await endpoint.handle({ body: { version: 3, contexts: [{ key }],
			command: 'send-message', args: { content: 'committed' }, requestId, runBinding: token } });
		expect(first.status).toBe(200);
		// HTTP already committed; reset cannot claim a recall — the next attempt re-verifies:
		// the rotated key is unknown, and the fresh key with the old token is stale. Zero new
		// POST, no retargeting, no automatic new-ID resend.
		s.reset('7', '42');
		const retry = await endpoint.handle({ body: { version: 3, contexts: [{ key }],
			command: 'send-message', args: { content: 'committed' }, requestId, runBinding: token } });
		expect(retry).toMatchObject({ status: 404, json: { code: 'UNKNOWN_CONTEXT' } });
		const freshKey = s.get('7', '42')!.contextKey;
		expect(await endpoint.handle({ body: { version: 3, contexts: [{ key: freshKey }],
			command: 'send-message', args: { content: 'committed' }, requestId, runBinding: token } }))
			.toMatchObject({ status: 403, json: { code: 'FORBIDDEN' } });
		expect(posts).toHaveLength(1);
		s.close();
	});

	it('allows several replies of one run to share one flag target (many rel, one thinkingId)', async () => {
		const { s, key, token } = setupBound();
		const { posts } = serverEmulator();
		const endpoint = liveEndpoint(s, new HulaApiClient('http://test', 'secret'));
		for (const content of ['first', 'second']) {
			const res = await endpoint.handle({ body: { version: 3, contexts: [{ key }],
				command: 'send-message', args: { content }, requestId: generatedId(), runBinding: token } });
			expect(res).toMatchObject({ status: 200, json: { result: { thinkingId: '555' } } });
		}
		expect(posts).toHaveLength(2);
		expect(posts[0].extra).toEqual(posts[1].extra);
		s.close();
	});
});

describe('send-message capability association extras', () => {
	function fakeClient(captured: Array<Record<string, unknown> | undefined>) {
		return { supportsMessageReceipts: async () => true,
			sendMessage: async (_room: string, _content: string, extra?: Record<string, unknown>, _id?: string) => {
				captured.push(extra);
				return { msgId: '1' };
			} } as unknown as HulaApiClient;
	}
	it('durable carries cliGeneration + verified thinkingId, and reports it back', async () => {
		const captured: Array<Record<string, unknown> | undefined> = [];
		const registry = new CapabilityRegistry();
		registry.register('send-message', sendMessageCapability());
		const result = await registry.invoke('send-message',
			{ aiclawUid: '7', roomId: '42', apiClient: fakeClient(captured), generation: 3,
				requestId: generatedId(), replyThinkingId: '555' }, { content: 'hi' });
		expect(captured[0]).toEqual({ cliGeneration: 3, thinkingId: '555' });
		expect(result).toMatchObject({ msgId: '1', thinkingId: '555' });
	});
	it('unassociated sends carry no thinkingId and claim none', async () => {
		const captured: Array<Record<string, unknown> | undefined> = [];
		const registry = new CapabilityRegistry();
		registry.register('send-message', sendMessageCapability());
		const result = await registry.invoke('send-message',
			{ aiclawUid: '7', roomId: '42', apiClient: fakeClient(captured), generation: 3,
				requestId: generatedId() }, { content: 'hi' });
		expect(captured[0]).toEqual({ cliGeneration: 3 });
		expect(result).not.toHaveProperty('thinkingId');
	});
});
