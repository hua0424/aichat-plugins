import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityEndpoint } from './endpoint.js';
import { CapabilityRegistry, sendMessageCapability } from './registry.js';
import type { HulaApiClient } from '../api/hula-api.js';

/**
 * Build an endpoint wired to a real registry (send-message) + a controllable resolve. The fake
 * apiClient's sendMessage is the observable seam: we assert which roomId it received.
 */
function build(opts?: { resolveRoom?: number | undefined; idempotencyCap?: number }) {
	const sendMessage = vi.fn(async () => ({ msgId: 1 }));
	const apiClient = { sendMessage } as unknown as HulaApiClient;
	const registry = new CapabilityRegistry();
	registry.register('send-message', sendMessageCapability());
	const resolve = vi.fn((_sessionKey: string) => {
		if (opts?.resolveRoom === undefined) return undefined;
		return { aiclawUid: 7, roomId: opts.resolveRoom, apiClient };
	});
	const endpoint = new CapabilityEndpoint({ registry, resolve, idempotencyCap: opts?.idempotencyCap });
	return { endpoint, sendMessage, resolve };
}

function body(over?: Record<string, unknown>) {
	return {
		sessionKey: 'opencode:ses_1',
		command: 'send-message',
		args: { content: 'hi' },
		idempotencyKey: 'idem-1',
		...over,
	};
}

describe('CapabilityEndpoint.handle', () => {
	it('resolves sessionKey → invokes capability with the RESOLVED roomId (not args.room)', async () => {
		const { endpoint, sendMessage } = build({ resolveRoom: 42 });
		const res = await endpoint.handle({ body: body({ args: { content: 'hi', room: 999 } }) });
		expect(res.status).toBe(200);
		expect(res.json).toMatchObject({ ok: true });
		// the spoofed args.room=999 was ignored; the resolved room 42 was used
		expect(sendMessage).toHaveBeenCalledWith(42, 'hi');
	});

	it('non-loopback remoteAddress → 403, capability NOT invoked', async () => {
		const { endpoint, sendMessage } = build({ resolveRoom: 42 });
		const res = await endpoint.handle({ body: body(), remoteAddress: '10.0.0.5' });
		expect(res.status).toBe(403);
		expect(sendMessage).not.toHaveBeenCalled();
	});

	it('loopback remoteAddress is allowed', async () => {
		const { endpoint, sendMessage } = build({ resolveRoom: 42 });
		for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
			sendMessage.mockClear();
			// distinct idempotencyKey per address so the dedup cache doesn't swallow the re-invoke
			const res = await endpoint.handle({ body: body({ idempotencyKey: `idem-${addr}` }), remoteAddress: addr });
			expect(res.status).toBe(200);
			expect(sendMessage).toHaveBeenCalledOnce();
		}
	});

	it('same (sessionKey, idempotencyKey) twice → capability invoked ONCE + identical response', async () => {
		const { endpoint, sendMessage } = build({ resolveRoom: 42 });
		const first = await endpoint.handle({ body: body() });
		const second = await endpoint.handle({ body: body() });
		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect(second).toEqual(first);
	});

	it('different idempotencyKey → capability invoked twice', async () => {
		const { endpoint, sendMessage } = build({ resolveRoom: 42 });
		await endpoint.handle({ body: body({ idempotencyKey: 'a' }) });
		await endpoint.handle({ body: body({ idempotencyKey: 'b' }) });
		expect(sendMessage).toHaveBeenCalledTimes(2);
	});

	it('unknown sessionKey (resolve → undefined) → 404, capability NOT invoked', async () => {
		const { endpoint, sendMessage } = build({ resolveRoom: undefined });
		const res = await endpoint.handle({ body: body() });
		expect(res.status).toBe(404);
		expect((res.json as { ok: boolean }).ok).toBe(false);
		expect(sendMessage).not.toHaveBeenCalled();
	});

	it('unknown command → 400', async () => {
		const { endpoint, sendMessage } = build({ resolveRoom: 42 });
		const res = await endpoint.handle({ body: body({ command: 'no-such-command' }) });
		expect(res.status).toBe(400);
		expect(sendMessage).not.toHaveBeenCalled();
	});

	it('sessionKey with no known prefix → 400, resolve + capability NOT invoked', async () => {
		const { endpoint, sendMessage, resolve } = build({ resolveRoom: 42 });
		const res = await endpoint.handle({ body: body({ sessionKey: 'ses_no_prefix' }) });
		expect(res.status).toBe(400);
		expect((res.json as { ok: boolean }).ok).toBe(false);
		// the prefix gate rejects BEFORE resolve/idempotency/dispatch
		expect(resolve).not.toHaveBeenCalled();
		expect(sendMessage).not.toHaveBeenCalled();
	});

	it('valid opencode:-prefixed key still flows to resolve as before', async () => {
		const { endpoint, sendMessage, resolve } = build({ resolveRoom: 42 });
		const res = await endpoint.handle({ body: body({ sessionKey: 'opencode:ses_ok' }) });
		expect(res.status).toBe(200);
		expect(resolve).toHaveBeenCalledWith('opencode:ses_ok');
		expect(sendMessage).toHaveBeenCalledOnce();
	});

	it('idempotency cache is FIFO-bounded: oldest key is evicted once the cap is exceeded', async () => {
		// cap=3: after driving 4 distinct keys, the first ('k0') must have been evicted.
		const { endpoint, sendMessage } = build({ resolveRoom: 42, idempotencyCap: 3 });
		for (let i = 0; i < 4; i++) {
			await endpoint.handle({ body: body({ idempotencyKey: `k${i}` }) });
		}
		expect(sendMessage).toHaveBeenCalledTimes(4);
		// Re-sending the evicted 'k0' re-invokes (proving it was dropped, i.e. the Map stays bounded).
		await endpoint.handle({ body: body({ idempotencyKey: 'k0' }) });
		expect(sendMessage).toHaveBeenCalledTimes(5);
		// A still-cached key ('k3', the newest) is NOT re-invoked.
		await endpoint.handle({ body: body({ idempotencyKey: 'k3' }) });
		expect(sendMessage).toHaveBeenCalledTimes(5);
	});

	it('capability throw → 500 with error', async () => {
		const { endpoint } = build({ resolveRoom: 42 });
		// empty content makes sendMessageCapability throw
		const res = await endpoint.handle({ body: body({ args: { content: '' } }) });
		expect(res.status).toBe(500);
		expect((res.json as { ok: boolean }).ok).toBe(false);
	});
});

describe('CapabilityEndpoint.listen socket permissions', () => {
	const dirs: string[] = [];
	let endpoint: CapabilityEndpoint | null = null;

	afterEach(async () => {
		if (endpoint) {
			await endpoint.close();
			endpoint = null;
		}
		for (const d of dirs.splice(0)) {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it('binds the socket 0600 inside a 0700 parent dir (anti-spoofing)', async () => {
		const { endpoint: ep } = build({ resolveRoom: 42 });
		endpoint = ep;
		// nest a private subdir so the parent dir mode assertion is meaningful (mkdirSync creates it)
		const base = mkdtempSync(join(tmpdir(), 'aichat-cap-'));
		dirs.push(base);
		const dir = join(base, 'priv');
		const socketPath = join(dir, 'capability.sock');

		await endpoint.listen(socketPath);

		// On Linux the mode bits are honored; mask to the permission bits only.
		expect(statSync(socketPath).mode & 0o777).toBe(0o600);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
	});
});
