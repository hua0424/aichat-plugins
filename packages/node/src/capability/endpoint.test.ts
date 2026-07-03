import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityEndpoint, maskSessionKey, sanitizeLogField } from './endpoint.js';
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
	const endpoint = new CapabilityEndpoint({
		registry,
		resolve,
		idempotencyCap: opts?.idempotencyCap,
	});
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

describe('CapabilityEndpoint.handle observability log ([capability])', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('success branch logs one ok line with resolved uid/room', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const { endpoint } = build({ resolveRoom: 42 });
		const res = await endpoint.handle({ body: body() });
		expect(res.status).toBe(200);
		const capLines = logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[capability]'));
		expect(capLines).toHaveLength(1);
		expect(capLines[0]).toMatch(/^\[capability\] send-message .+ → \(uid=7, room=42\) ok$/);
	});

	it('resolve-failure branch logs one (unresolved) unknown session line', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const { endpoint } = build({ resolveRoom: undefined });
		const res = await endpoint.handle({ body: body() });
		expect(res.status).toBe(404);
		const capLines = logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[capability]'));
		expect(capLines).toHaveLength(1);
		expect(capLines[0]).toBe('[capability] send-message opencode:ses_1 → (unresolved) err=unknown session');
	});

	it('maskSessionKey masks a long id: prefix + first 8 chars + length, never the full id', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const { endpoint } = build({ resolveRoom: 42 });
		const longId = 'ses_0123456789abcdef_secret_tail';
		await endpoint.handle({ body: body({ sessionKey: `opencode:${longId}` }) });
		const line = logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('[capability]'))!;
		expect(line).toContain('…(');
		expect(line).toContain('opencode:ses_0123'); // prefix + first 8 chars of the id
		expect(line).not.toContain(longId); // the full id must NOT appear
	});

	it('capability-throw branch (500) logs one err line with resolved uid/room', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const { endpoint } = build({ resolveRoom: 42 });
		// send-message with no content → sendMessageCapability throws → 500 path.
		const res = await endpoint.handle({ body: body({ args: {} }) });
		expect(res.status).toBe(500);
		const capLines = logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[capability]'));
		expect(capLines).toHaveLength(1);
		expect(capLines[0]).toMatch(/^\[capability\] send-message .+ → \(uid=7, room=42\) err=send-message: `content` is required/);
	});

	it('prefix-parse-failure branch (400) logs one (unresolved) unknown session key prefix line', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const { endpoint } = build({ resolveRoom: 42 });
		// `raw:` is not a KNOWN agent-type prefix → parseSessionKey fails → 400 before resolve.
		const res = await endpoint.handle({ body: body({ sessionKey: 'raw:whatever' }) });
		expect(res.status).toBe(400);
		const capLines = logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[capability]'));
		expect(capLines).toHaveLength(1);
		expect(capLines[0]).toBe('[capability] send-message raw:whatever → (unresolved) err=unknown session key prefix');
	});

	it('unknown-command branch (400) logs one err line with resolved uid/room', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const { endpoint } = build({ resolveRoom: 42 });
		const res = await endpoint.handle({ body: body({ command: 'nope-not-registered' }) });
		expect(res.status).toBe(400);
		const capLines = logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[capability]'));
		expect(capLines).toHaveLength(1);
		expect(capLines[0]).toBe('[capability] nope-not-registered opencode:ses_1 → (uid=7, room=42) err=unknown command');
	});

	it('CRLF in an untrusted command cannot forge a second log line', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const { endpoint } = build({ resolveRoom: 42 });
		// Attacker-controlled command with an embedded newline + fake log line, on the unknown-command path.
		await endpoint.handle({ body: body({ command: 'evil\n[capability] FORGED → (uid=0, room=0) ok' }) });
		const capLines = logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[capability]'));
		// Exactly ONE console.log call, and the embedded newline is neutralized (→ space) so the forged
		// text can never become a SEPARATE physical log line. (The text survives inline, harmlessly.)
		expect(capLines).toHaveLength(1);
		expect(capLines[0]).not.toContain('\n');
		expect(capLines[0]).toContain('[capability] evil [capability] FORGED'); // newline flattened to a space
	});
});

describe('endpoint log-sanitizer helpers', () => {
	it('sanitizeLogField replaces CR/LF + control chars with spaces', () => {
		expect(sanitizeLogField('a\r\nb\tc')).toBe('a  b c');
		expect(sanitizeLogField('plain')).toBe('plain');
	});

	it('sanitizeLogField truncates past max with an ellipsis', () => {
		expect(sanitizeLogField('x'.repeat(10), 4)).toBe('xxxx…');
		expect(sanitizeLogField('abc', 4)).toBe('abc');
	});

	it('maskSessionKey: no colon → <no-prefix>; short id kept; long id masked; control chars stripped', () => {
		expect(maskSessionKey('noprefix')).toBe('<no-prefix>');
		expect(maskSessionKey('cc:short')).toBe('cc:short');
		expect(maskSessionKey('opencode:0123456789abcdef')).toBe('opencode:01234567…(16)');
		expect(maskSessionKey('cc:a\nb')).toBe('cc:a b'); // embedded newline in a short id → space
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
