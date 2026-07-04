import { describe, it, expect, vi } from 'vitest';
import { CapabilityEndpoint } from './endpoint.js';
import { CapabilityRegistry, sendMessageCapability } from './registry.js';
import { resolveBoundSession, type BindableAgent } from './session-key.js';
import { OpenclawDriver } from '../agent/openclaw-driver.js';
import { CcHeadlessDriver } from '../agent/cc/headless-driver.js';
import { InMemoryBindTokenStore } from '../agent/bind-token-store.js';
import { CcSessionRegistry } from '../agent/cc/sink.js';
import type { ClawAdapter } from '../claw/interface.js';
import type { HulaApiClient } from '../api/hula-api.js';
import type { CcHeadlessSessionStore, StoredCcHeadlessSession } from '../agent/cc/headless-session-store.js';

/**
 * BL-014 (#141) — THE anti-forgery property, end-to-end.
 *
 * Before this change the agent-facing binding was the PLAINTEXT `aiclaw-{uid}-room-{roomId}` string,
 * injected as OPENCLAW_BIND / AICHAT_BIND and regex-parsed by resolveSession. A bash-capable agent could
 * overwrite that env var with a GUESSED (uid,room) and call capabilities as another identity/room.
 *
 * Now the agent-facing value is a node-minted OPAQUE token, and resolveSession is a STORE LOOKUP. A
 * forged plaintext binding (`openclaw:aiclaw-999-room-888` / `cc:aiclaw-999-room-888`) is not a minted
 * token → resolveSession/store returns undefined → the capability endpoint returns 404 "unknown session".
 * A genuinely minted token resolves to its real (uid,room). This test proves BOTH, at the endpoint level.
 */

function noopClawAdapter(): ClawAdapter {
	return {
		type: 'openclaw',
		connect: vi.fn().mockResolvedValue(undefined),
		disconnect: vi.fn().mockResolvedValue(undefined),
		get isConnected() {
			return true;
		},
		chat: vi.fn().mockResolvedValue(undefined),
	} as unknown as ClawAdapter;
}

function memCcStore(): CcHeadlessSessionStore {
	const map = new Map<string, StoredCcHeadlessSession>();
	return { get: (k) => map.get(k), set: (k, v) => void map.set(k, v), delete: (k) => void map.delete(k) };
}

/** A tagged fake api client so we can assert WHICH identity's client the endpoint would reply through. */
function fakeApi(tag: string): HulaApiClient {
	return { sendMessage: vi.fn(async () => ({ msgId: 1 })), __tag: tag } as unknown as HulaApiClient;
}

describe('BL-014 (#141) anti-forgery — forged plaintext binding never resolves; minted token does', () => {
	it('openclaw: a minted token resolves to its real (uid,room); a forged plaintext binding → endpoint 404', async () => {
		// ONE shared store, as in start.ts. Mint the REAL binding via the driver's openSession.
		const store = new InMemoryBindTokenStore();
		const openclaw = new OpenclawDriver(noopClawAdapter(), store);
		const api7 = fakeApi('uid-7');
		await openclaw.openSession({ aiclawUid: '7', roomId: '42', chatContext: {} });
		const mintedToken = store.mint('7', '42'); // stable → the exact token openSession minted

		const agents: BindableAgent[] = [{ driver: openclaw, uid: '7', api: api7 } as unknown as BindableAgent];

		const registry = new CapabilityRegistry();
		registry.register('send-message', sendMessageCapability());
		const endpoint = new CapabilityEndpoint({
			registry,
			resolve: (sk) => resolveBoundSession(sk, agents),
		});

		// (1) FORGED plaintext binding — what an agent gets by overwriting OPENCLAW_BIND with a guessed
		//     (uid,room). It is NOT a minted token → resolve → undefined → 404 "unknown session".
		const forged = await endpoint.handle({
			body: { sessionKey: 'openclaw:aiclaw-999-room-888', command: 'send-message', args: { content: 'pwn' }, idempotencyKey: 'f1' },
		});
		expect(forged.status).toBe(404);
		expect((forged.json as { error: string }).error).toBe('unknown session');

		// (2) GENUINE minted token → resolves to the real (uid,room) → 200.
		const genuine = await endpoint.handle({
			body: { sessionKey: `openclaw:${mintedToken}`, command: 'send-message', args: { content: 'hi' }, idempotencyKey: 'g1' },
		});
		expect(genuine.status).toBe(200);
		expect((genuine.json as { ok: boolean }).ok).toBe(true);
		// and the resolved room is the REAL bound room 42 (never taken from args).
		expect((api7 as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage).toHaveBeenCalledWith('42', 'hi');

		// (3) COMPOUND forgery (#141 B+ manager hard requirement #1): an attacker appends a plaintext
		//     binding tail to a GENUINELY-MINTED token → `openclaw:<token>:aiclaw-999-room-888`. The
		//     compound `<token>:<binding>` only legitimately exists GATEWAY-SIDE (in adapter.chat's
		//     ctx.sessionKey). The endpoint's resolveSession does an EXACT store lookup of the WHOLE
		//     post-prefix id — it NEVER splits on `:` — so the compound is not a stored key → store MISS
		//     → 404. This locks that the bare token from (2) is the only thing that resolves at the endpoint.
		const compound = await endpoint.handle({
			body: { sessionKey: `openclaw:${mintedToken}:aiclaw-999-room-888`, command: 'send-message', args: { content: 'pwn' }, idempotencyKey: 'c1' },
		});
		expect(compound.status).toBe(404);
		expect((compound.json as { error: string }).error).toBe('unknown session');
	});

	it('cc: a minted token resolves; a forged `cc:aiclaw-…` plaintext binding → endpoint 404', async () => {
		const store = new InMemoryBindTokenStore();
		const cc = new CcHeadlessDriver({
			workspaceBase: '/tmp/aichat-antiforgery-cc',
			brokerPort: 9100,
			sessionStore: memCcStore(),
			bindTokens: store,
			registry: new CcSessionRegistry(),
			transcript: { append: () => {} },
			spawn: (() => {
				throw new Error('should not spawn in this resolve-only test');
			}) as never,
		});
		const api5 = fakeApi('uid-5');
		// mint the real (5,9) binding directly (openSession would spawn; we only need the token).
		const mintedToken = store.mint('5', '9');

		const agents: BindableAgent[] = [{ driver: cc, uid: '5', api: api5 } as unknown as BindableAgent];

		const registry = new CapabilityRegistry();
		registry.register('send-message', sendMessageCapability());
		const endpoint = new CapabilityEndpoint({
			registry,
			resolve: (sk) => resolveBoundSession(sk, agents),
		});

		// FORGED plaintext binding under the cc: prefix → 404.
		const forged = await endpoint.handle({
			body: { sessionKey: 'cc:aiclaw-999-room-888', command: 'send-message', args: { content: 'pwn' }, idempotencyKey: 'f2' },
		});
		expect(forged.status).toBe(404);
		expect((forged.json as { error: string }).error).toBe('unknown session');

		// GENUINE minted token → 200, replying through the real bound room 9.
		const genuine = await endpoint.handle({
			body: { sessionKey: `cc:${mintedToken}`, command: 'send-message', args: { content: 'hi' }, idempotencyKey: 'g2' },
		});
		expect(genuine.status).toBe(200);
		expect((api5 as unknown as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage).toHaveBeenCalledWith('9', 'hi');
	});
});
