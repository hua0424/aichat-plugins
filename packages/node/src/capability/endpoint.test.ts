import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, statSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { postCapability } from './client.js';
import {
	CapabilityEndpoint,
	capabilitySocketPath,
	maskSessionKey,
	prepareSocketPath,
	sanitizeLogField,
} from './endpoint.js';
import { CapabilityRegistry, sendMessageCapability } from './registry.js';
import { HulaApiRejectedError, type HulaApiClient } from '../api/hula-api.js';
import { resetSessionCapability } from './registry.js';

/**
 * Build an endpoint wired to a real registry (send-message) + a controllable resolve. The fake
 * apiClient's sendMessage is the observable seam: we assert which roomId it received.
 */
function build(opts?: { resolveRoom?: number | undefined; platform?: NodeJS.Platform }) {
	const sendMessage = vi.fn(async () => ({ msgId: '1' }));
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
		platform: opts?.platform,
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

	it('old request IDs remain protected after more than the former 1000-entry cache limit', async () => {
		const { endpoint, sendMessage } = build({ resolveRoom: 42 });
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		for (let i = 0; i < 1001; i++) {
			await endpoint.handle({ body: body({ requestId: `k${i}`, idempotencyKey: undefined }) });
		}
		await endpoint.handle({ body: body({ requestId: 'k0', idempotencyKey: undefined }) });
		expect(sendMessage).toHaveBeenCalledTimes(1001);
		log.mockRestore();
	});

	it('invalid write args → 400, not cached under requestId', async () => {
		const { endpoint, sendMessage } = build({ resolveRoom: 42 });
		const res = await endpoint.handle({ body: body({ args: { content: '' } }) });
		expect(res.status).toBe(400);
		expect((res.json as { ok: boolean }).ok).toBe(false);
		expect((await endpoint.handle({ body: body() })).status).toBe(200);
		expect(sendMessage).toHaveBeenCalledOnce();
	});
});

describe('local write requestId', () => {
	function setup() {
		let release!: (id: { msgId: string }) => void;
		const sendMessage = vi.fn(() => new Promise<{ msgId: string }>((resolve) => { release = resolve; }));
		const apiClient = { sendMessage } as unknown as HulaApiClient;
		const registry = new CapabilityRegistry();
		registry.register('send-message', sendMessageCapability());
		registry.register('reset-session', async () => ({ reset: true }));
		let reads = 0;
		registry.register('list-friends', async () => ({ reads: ++reads }));
		const endpoint = new CapabilityEndpoint({
			registry,
			serverNamespace: 'https://server.example',
			resolve: (sessionKey) => sessionKey === 'opencode:revoked' ? undefined : {
				aiclawUid: sessionKey === 'cc:other' ? 'other' : 'owner',
				roomId: sessionKey === 'cc:room2' ? 'room2' : 'room1',
				apiClient,
			},
		});
		return { endpoint, sendMessage, complete: (id: string) => release({ msgId: id }) };
	}

	it('registers before invoking: two concurrent callers share a single real resolution/result', async () => {
		const { endpoint, sendMessage, complete } = setup();
		const request = body({ requestId: 'same', idempotencyKey: undefined });
		const a = endpoint.handle({ body: request });
		const b = endpoint.handle({ body: request });
		await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
		complete('101');
		const [first, second] = await Promise.all([a, b]);
		expect(first).toEqual(second);
		expect(first.json).toMatchObject({ result: { msgId: '101' } });
		expect(await endpoint.handle({ body: request })).toEqual(first);
	});

	it('conflicts on changed payload, room or command, but not ignored padding/token rotation', async () => {
		const { endpoint, sendMessage, complete } = setup();
		const sameId = { requestId: 'one', idempotencyKey: undefined };
		const first = endpoint.handle({ body: body({ ...sameId, args: { content: 'hi', metadata: { a: 1, b: 2 } } }) });
		await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
		const reordered = endpoint.handle({ body: body({ ...sameId, args: { metadata: { b: 2, a: 1 }, content: 'hi' } }) });
		for (const mismatch of [
			{ args: { content: 'changed' } },
			{ sessionKey: 'cc:room2' },
			{ command: 'reset-session' },
		]) {
			expect((await endpoint.handle({ body: body({ ...sameId, ...mismatch }) })).status).toBe(409);
		}
		const otherToken = endpoint.handle({ body: body({ ...sameId, sessionKey: 'opencode:rotated', args: { content: 'hi' } }) });
		complete('102');
		expect(await otherToken).toEqual(await first);
		expect(await reordered).toEqual(await first);
		expect(sendMessage).toHaveBeenCalledTimes(1);
	});

	it('same requestId across identities is independent, while reads never consume or cache a write ID', async () => {
		const { endpoint, sendMessage, complete } = setup();
		const read = body({ command: 'list-friends', requestId: 'shared', idempotencyKey: undefined });
		expect((await endpoint.handle({ body: read })).json).toMatchObject({ result: { reads: 1 } });
		const write = body({ requestId: 'shared', idempotencyKey: undefined });
		const first = endpoint.handle({ body: write });
		await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
		complete('103');
		await first;
		expect((await endpoint.handle({ body: read })).json).toMatchObject({ result: { reads: 2 } });
		const second = endpoint.handle({ body: body({ ...write, sessionKey: 'cc:other' }) });
		await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
		complete('104');
		expect((await second).json).toMatchObject({ result: { msgId: '104' } });
	});

	it('never treats an unknown write or revoked binding as an unsubmitted request', async () => {
		const { endpoint, sendMessage } = setup();
		sendMessage.mockRejectedValueOnce(new Error('network reset'));
		const request = body({ requestId: 'uncertain', idempotencyKey: undefined });
		const first = await endpoint.handle({ body: request });
		expect(first).toMatchObject({ status: 503, json: { code: 'DELIVERY_UNKNOWN', requestId: 'uncertain' } });
		expect(await endpoint.handle({ body: request })).toEqual(first);
		expect(sendMessage).toHaveBeenCalledTimes(1);
		expect((await endpoint.handle({ body: body({ ...request, sessionKey: 'opencode:revoked' }) })).status).toBe(404);
	});

	it('reset receipt remains available only for its old key and exact ID after reset revokes the binding', async () => {
		let active = true;
		const registry = new CapabilityRegistry();
		const reset = vi.fn(() => { active = false; return { driverType: 'codex', reset: true }; });
		registry.register('reset-session', resetSessionCapability(reset));
		const endpoint = new CapabilityEndpoint({
			registry,
			resolve: () => active ? { aiclawUid: 'owner', roomId: 'room1', apiClient: {} as HulaApiClient } : undefined,
		});
		const request = body({ command: 'reset-session', args: {}, requestId: 'reset-id', idempotencyKey: undefined });
		const first = await endpoint.handle({ body: request });
		expect(first).toMatchObject({ status: 200, json: { result: { reset: true } } });
		expect(await endpoint.handle({ body: request })).toEqual(first);
		expect(reset).toHaveBeenCalledOnce();
		expect((await endpoint.handle({ body: body({ command: 'list-friends', requestId: 'reset-id', idempotencyKey: undefined }) })).status).toBe(404);
		expect((await endpoint.handle({ body: body({ command: 'reset-session', args: {}, requestId: 'other', idempotencyKey: undefined }) })).status).toBe(404);
	});

	it('confirmed reset advances the same room generation so old send IDs cannot be replayed', async () => {
		const { endpoint, sendMessage, complete } = setup();
		const request = body({ requestId: 'pre-reset', idempotencyKey: undefined });
		const pending = endpoint.handle({ body: request });
		await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
		complete('108');
		await pending;
		expect((await endpoint.handle({ body: body({ command: 'reset-session', args: {}, requestId: 'reset', idempotencyKey: undefined }) })).status).toBe(200);
		// setup() registers a reset capability, but only its reset:true result advances generation.
		expect((await endpoint.handle({ body: request })).status).toBe(409);
		expect(sendMessage).toHaveBeenCalledOnce();
	});

	it('definitive server rejection does not poison an ID; a later corrected retry may execute', async () => {
		const { endpoint, sendMessage } = setup();
		sendMessage.mockRejectedValueOnce(new HulaApiRejectedError('forbidden', 'FORBIDDEN')).mockResolvedValueOnce({ msgId: '106' });
		const request = body({ requestId: 'rejected', idempotencyKey: undefined });
		expect(await endpoint.handle({ body: request })).toMatchObject({ status: 403, json: { code: 'FORBIDDEN' } });
		expect((await endpoint.handle({ body: request })).status).toBe(200);
		expect(sendMessage).toHaveBeenCalledTimes(2);
	});

	it('ignored deep padding cannot recursively crash a valid write', async () => {
		const { endpoint, sendMessage, complete } = setup();
		let padding: unknown = null;
		for (let i = 0; i < 3000; i++) padding = { padding };
		const request = body({ requestId: 'deep', idempotencyKey: undefined, args: { content: 'hi', padding } });
		const first = endpoint.handle({ body: request });
		await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
		complete('107');
		expect((await first).status).toBe(200);
	});

	it('HTTP named-pipe requests with the same explicit ID share one backend write', async () => {
		const { endpoint, sendMessage, complete } = setup();
		const socket = process.platform === 'win32' ? `\\\\.\\pipe\\aichat-idem-test-${randomUUID()}` : join(mkdtempSync(join(tmpdir(), 'aichat-idem-')), 'capability.sock');
		await endpoint.listen(socket);
		try {
			const payload = body({ requestId: 'http', idempotencyKey: undefined });
			const a = postCapability(socket, payload);
			const b = postCapability(socket, payload);
			await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
			complete('105');
			const [one, two] = await Promise.all([a, b]);
			expect(one).toEqual(two);
			expect(one).toMatchObject({ status: 200, body: { result: { msgId: '105' } } });
		} finally {
			await endpoint.close();
			if (process.platform !== 'win32') rmSync(join(socket, '..'), { recursive: true, force: true });
		}
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
		expect(capLines[0]).toBe('[capability] send-message opencode:…(5) → (unresolved) err=unknown session');
	});

	it('BL-014 (#141): maskSessionKey FULLY masks the id (prefix + length only, no head)', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const { endpoint } = build({ resolveRoom: 42 });
		const longId = 'ses_0123456789abcdef_secret_tail';
		await endpoint.handle({ body: body({ sessionKey: `opencode:${longId}` }) });
		const line = logSpy.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('[capability]'))!;
		expect(line).toContain(`opencode:…(${longId.length})`); // prefix + length only
		expect(line).not.toContain('ses_0123'); // NOT even the first 8 chars — the token is a credential
		expect(line).not.toContain(longId); // the full id must NOT appear
	});

	it('capability-throw branch (500) logs one err line with resolved uid/room', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const { endpoint, sendMessage } = build({ resolveRoom: 42 });
		sendMessage.mockRejectedValueOnce(new Error('upstream failed'));
		const res = await endpoint.handle({ body: body() });
		expect(res.status).toBe(503);
		const capLines = logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[capability]'));
		expect(capLines).toHaveLength(1);
		expect(capLines[0]).toMatch(/^\[capability\] send-message .+ → \(uid=7, room=42\) err=upstream failed/);
	});

	it('prefix-parse-failure branch (400) logs one (unresolved) unknown session key prefix line', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const { endpoint } = build({ resolveRoom: 42 });
		// `raw:` is not a KNOWN agent-type prefix → parseSessionKey fails → 400 before resolve.
		const res = await endpoint.handle({ body: body({ sessionKey: 'raw:whatever' }) });
		expect(res.status).toBe(400);
		const capLines = logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[capability]'));
		expect(capLines).toHaveLength(1);
		expect(capLines[0]).toBe('[capability] send-message raw:…(8) → (unresolved) err=unknown session key prefix');
	});

	it('unknown-command branch (400) logs one err line with resolved uid/room', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const { endpoint } = build({ resolveRoom: 42 });
		const res = await endpoint.handle({ body: body({ command: 'nope-not-registered' }) });
		expect(res.status).toBe(400);
		const capLines = logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[capability]'));
		expect(capLines).toHaveLength(1);
		expect(capLines[0]).toBe('[capability] nope-not-registered opencode:…(5) → (uid=7, room=42) err=unknown command');
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

	it('BL-014 (#141): maskSessionKey → prefix + length only (id fully masked); no colon → <no-prefix>', () => {
		expect(maskSessionKey('noprefix')).toBe('<no-prefix>');
		expect(maskSessionKey('cc:short')).toBe('cc:…(5)'); // even a short id is masked (it is a token)
		expect(maskSessionKey('opencode:0123456789abcdef')).toBe('opencode:…(16)');
		expect(maskSessionKey('cc:a\nb')).toBe('cc:…(3)'); // id `a\nb` has length 3; nothing of it is emitted
	});
});

describe('capabilitySocketPath (platform-aware)', () => {
	it('win32 → valid named-pipe path hashed from home, with NO colon', () => {
		const p = capabilitySocketPath({ platform: 'win32', home: 'C:\\Users\\bob\\.aichat' });
		expect(p).toMatch(/^\\\\\.\\pipe\\aichat-capability-[0-9a-f]{16}$/);
		expect(p).not.toContain(':');
	});

	it('deterministic: same home twice → identical path', () => {
		const a = capabilitySocketPath({ platform: 'win32', home: 'C:\\Users\\bob\\.aichat' });
		const b = capabilitySocketPath({ platform: 'win32', home: 'C:\\Users\\bob\\.aichat' });
		expect(a).toBe(b);
	});

	it('per-user: two different homes → different pipes (named pipes are machine-wide)', () => {
		const a = capabilitySocketPath({ platform: 'win32', home: 'C:\\Users\\alice\\.aichat' });
		const b = capabilitySocketPath({ platform: 'win32', home: 'C:\\Users\\bob\\.aichat' });
		expect(a).not.toBe(b);
	});

	it('linux → <home>/capability.sock (unchanged regression)', () => {
		expect(capabilitySocketPath({ platform: 'linux', home: '/home/bob/.aichat' })).toBe(
			'/home/bob/.aichat/capability.sock',
		);
	});

	it('env override wins on win32, returned verbatim', () => {
		expect(
			capabilitySocketPath({
				platform: 'win32',
				env: { AICHAT_CAPABILITY_SOCK: '\\\\.\\pipe\\custom' },
				home: 'C:\\Users\\bob\\.aichat',
			}),
		).toBe('\\\\.\\pipe\\custom');
	});
});

describe('prepareSocketPath (platform-aware)', () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const d of dirs.splice(0)) {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it('win32 → NO-OP: parent dir of a missing path is NOT created', () => {
		const base = mkdtempSync(join(tmpdir(), 'aichat-cap-'));
		dirs.push(base);
		const missingDir = join(base, 'does-not-exist');
		const socketPath = join(missingDir, 'capability.sock');

		prepareSocketPath(socketPath, 'win32');

		// Nothing touched on disk: no mkdir, no dir chmod, no stale unlink.
		expect(existsSync(missingDir)).toBe(false);
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

	it.runIf(process.platform !== 'win32')('binds the socket 0600 inside a 0700 parent dir (anti-spoofing)', async () => {
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

	it.runIf(process.platform !== 'win32')('win32 deps → resolves and the socket chmod 0600 is SKIPPED (named pipe, no fs chmod)', async () => {
		const { endpoint: ep } = build({ resolveRoom: 42, platform: 'win32' });
		endpoint = ep;
		const base = mkdtempSync(join(tmpdir(), 'aichat-cap-'));
		dirs.push(base);
		const socketPath = join(base, 'capability.sock');

		await endpoint.listen(socketPath);

		// On win32 the chmod is a POSIX-only anti-spoofing guard → skipped, so the file keeps its
		// default (non-0600) mode. (close() also skips unlink on win32 → rmSync in afterEach cleans up.)
		expect(statSync(socketPath).mode & 0o777).not.toBe(0o600);
	});
});
