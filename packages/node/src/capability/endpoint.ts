import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { readJsonBody } from '../util/http-body.js';
import { unlinkSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, posix } from 'node:path';
import { AICHAT_HOME } from '../config.js';
import { CapabilityRejectedError, type CapabilityRegistry, type CapabilityContext } from './registry.js';
import { HulaApiRejectedError, type HulaApiClient } from '../api/hula-api.js';
import { parseSessionKey } from './session-key.js';
import { errMsg } from '../util/err.js';

/** The resolve() result: the bound identity+room + the per-identity api client (REQ-029: opaque strings). */
type Resolved = { aiclawUid: string; roomId: string; apiClient: HulaApiClient };

export interface CapabilityEndpointDeps {
	registry: CapabilityRegistry;
	/** Map an agent session key → bound identity/room/api, or undefined if unknown. */
	resolve: (sessionKey: string) => Resolved | undefined;
	/** Namespaces request IDs to this configured server, not another backend. */
	serverNamespace?: string;
	/** Maximum admitted local write IDs; reject NEW IDs when full rather than evict safely recorded ones. */
	maxWriteIds?: number;
	/** Test seam: force win32 behavior (named pipe, skip POSIX chmod/cleanup) on any host. */
	platform?: NodeJS.Platform;
}

/** A parsed capability request body. */
interface CapabilityRequest {
	sessionKey: string;
	command: string;
	args: Record<string, unknown>;
	requestId?: string;
}

/** The handle() result: an HTTP status + JSON payload. */
export interface CapabilityResponse {
	status: number;
	json: unknown;
}

/** Loopback addresses node:http reports for local connections. */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * REQ-010 S1 — node-local capability endpoint (Flow2).
 *
 * `handle()` is the unit-testable core: it registers write promises before dispatch, retains
 * local receipts, and applies the loopback guard / resolve / dedup / dispatch rules. `listen()`/`close()` are a thin node:http
 * wrapper over a UNIX domain socket that feeds bodies into `handle()`.
 *
 * Anti-spoofing: the room/identity are taken ONLY from `resolve(sessionKey)` — never from the
 * request args. The agent's CLI carries only its session id, never room/identity.
 */
export class CapabilityEndpoint {
	private readonly registry: CapabilityRegistry;
	private readonly resolve: (sessionKey: string) => Resolved | undefined;
	/** In-flight writes remain registered until resolution, even when completed receipts reach the cap. */
	private readonly inFlight = new Map<string, { fingerprint: string; result: Promise<CapabilityResponse> }>();
	private readonly completed = new Map<string, { fingerprint: string; result: CapabilityResponse }>();
	/** An unknown result must never be evicted as if the write had not happened. */
	private readonly unknown = new Map<string, { fingerprint: string; result: CapabilityResponse }>();
	/** Minimal reset receipt survives its own removal of the bound native session. */
	private readonly resetReceipts = new Map<string, Promise<CapabilityResponse>>();
	private readonly roomGeneration = new Map<string, number>();
	private readonly serverNamespace: string;
	private readonly maxWriteIds: number;
	/** POSIX fs guards (dir/socket chmod, stale unlink) apply only on non-win32. */
	private readonly platform: NodeJS.Platform;
	private server: Server | null = null;
	private socketPath: string | null = null;

	constructor(deps: CapabilityEndpointDeps) {
		this.registry = deps.registry;
		this.resolve = deps.resolve;
		this.serverNamespace = deps.serverNamespace ?? '';
		this.maxWriteIds = deps.maxWriteIds ?? 100_000;
		if (!Number.isSafeInteger(this.maxWriteIds) || this.maxWriteIds < 1) throw new Error('maxWriteIds must be a positive integer');
		this.platform = deps.platform ?? process.platform;
	}

	async handle(req: { body: unknown; remoteAddress?: string }): Promise<CapabilityResponse> {
		// Non-local guard (defense-in-depth; a unix socket reports remoteAddress undefined → allowed).
		if (req.remoteAddress !== undefined && !LOOPBACK.has(req.remoteAddress)) {
			return { status: 403, json: { ok: false, error: 'forbidden: non-local connection' } };
		}

		const parsed = parseBody(req.body);
		if (!parsed) {
			return { status: 400, json: { ok: false, error: 'bad request: invalid body' } };
		}

		// REQ-010 S5: require a KNOWN agent-type prefix BEFORE resolve/idempotency/dispatch. An
		// unprefixed/unknown key never identifies a driver, so reject it deterministically (400) rather
		// than letting it fall through to resolve. (A valid prefix that simply has no live driver/session
		// still returns the existing 404 'unknown session' via resolve → undefined.)
		if (!parseSessionKey(parsed.sessionKey)) {
			// parsed.command exists here → cheap "解析失败" observability signal.
			// command + sessionKey are untrusted request input → sanitize to prevent CRLF log forgery.
			console.log(
				`[capability] ${sanitizeLogField(parsed.command, 64)} ${maskSessionKey(parsed.sessionKey)} → (unresolved) err=unknown session key prefix`,
			);
			return { status: 400, json: { ok: false, error: 'unknown or missing session key prefix' } };
		}

		// A reset invalidates its own native session key. The same key may retrieve ONLY that
		// reset's minimal receipt; no other write/query bypasses live binding resolution.
		const resetReceiptKey = parsed.command === 'reset-session' && parsed.requestId
			? JSON.stringify([parsed.sessionKey, parsed.requestId]) : undefined;
		if (resetReceiptKey) {
			const receipt = this.resetReceipts.get(resetReceiptKey);
			if (receipt) return Object.keys(parsed.args).length
				? { status: 409, json: { ok: false, code: 'IDEMPOTENCY_CONFLICT', error: 'requestId used with different write' } }
				: receipt;
		}
		const resolved = this.resolve(parsed.sessionKey);
		if (!resolved) {
			// not cached — an unresolved session is transient (could resolve next time)
			console.log(
				`[capability] ${sanitizeLogField(parsed.command, 64)} ${maskSessionKey(parsed.sessionKey)} → (unresolved) err=unknown session`,
			);
			return { status: 404, json: { ok: false, error: 'unknown session' } };
		}

		if (!this.registry.has(parsed.command)) {
			// Failure path — AC "成功/失败都有" covers it. command failed the registry whitelist → untrusted,
			// sanitize. uid/room are known here (session resolved), so log the full locator.
			console.log(
				`[capability] ${sanitizeLogField(parsed.command, 64)} ${maskSessionKey(parsed.sessionKey)} → (uid=${resolved.aiclawUid}, room=${resolved.roomId}) err=unknown command`,
			);
			return { status: 400, json: { ok: false, error: `unknown command: ${parsed.command}` } };
		}

		const ctx: CapabilityContext = {
			aiclawUid: resolved.aiclawUid,
			roomId: resolved.roomId,
			apiClient: resolved.apiClient,
		};
		const write = parsed.command === 'send-message' || parsed.command === 'reset-session';
		if (write && !parsed.requestId) {
			return { status: 400, json: { ok: false, error: 'requestId required for write' } };
		}
		// Key is the configured server + resolved identity, never a caller-supplied identity/room.
		if (parsed.command === 'send-message' && typeof parsed.args.content === 'string') parsed.args.content = parsed.args.content.trim();
		const key = write ? JSON.stringify([this.serverNamespace, resolved.aiclawUid, parsed.requestId]) : '';
		const roomKey = JSON.stringify([this.serverNamespace, resolved.aiclawUid, resolved.roomId]);
		// Only effective business args: never hash bearer/session tokens or ignored caller padding.
		const fingerprint = write ? createHash('sha256').update(JSON.stringify([
			parsed.command, resolved.roomId, this.roomGeneration.get(roomKey) ?? 0,
			typeof parsed.args.content === 'string' ? parsed.args.content : null,
		])).digest('hex') : '';
		if (write) {
			const prior = this.inFlight.get(key) ?? this.completed.get(key) ?? this.unknown.get(key);
			if (prior) {
				if (prior.fingerprint !== fingerprint) {
					return { status: 409, json: { ok: false, code: 'IDEMPOTENCY_CONFLICT', error: 'requestId used with different write' } };
				}
				return prior.result;
			}
		}
		if (parsed.command === 'send-message' &&
			(typeof parsed.args.content !== 'string' || !parsed.args.content)) {
			return { status: 400, json: { ok: false, error: 'send-message: `content` is required and must be a non-empty string' } };
		}
		if (parsed.command === 'reset-session' && Object.keys(parsed.args).length) {
			return { status: 400, json: { ok: false, code: 'INVALID_ARGUMENT', error: 'reset-session takes no args' } };
		}
		if (write && this.inFlight.size + this.completed.size + this.unknown.size >= this.maxWriteIds) {
			// ponytail: fail closed at receipt capacity; T15/T16 durable receipts permit safe eviction.
			return { status: 507, json: { ok: false, code: 'PERSISTENCE_FAILED', error: 'local write receipt capacity exhausted; no write started' } };
		}

		// No args (may contain message content), requestId or unmasked sessionKey in logs.
		const loc = `[capability] ${sanitizeLogField(parsed.command, 64)} ${maskSessionKey(parsed.sessionKey)} → (uid=${resolved.aiclawUid}, room=${resolved.roomId})`;
		const execute = async (): Promise<CapabilityResponse> => {
			try {
				const result = await this.registry.invoke(parsed.command, ctx, parsed.args);
				if (parsed.command === 'reset-session' && (result as { reset?: boolean })?.reset) {
					// Local generation changes only on a confirmed reset of this room.
					this.roomGeneration.set(roomKey, (this.roomGeneration.get(roomKey) ?? 0) + 1);
				}
				console.log(`${loc} ok`);
				return { status: 200, json: { ok: true, result } };
			} catch (err) {
				const msg = errMsg(err);
				console.log(`${loc} err=${sanitizeLogField(msg)}`);
				if (write && (err instanceof CapabilityRejectedError || err instanceof HulaApiRejectedError)) {
					const code = err instanceof HulaApiRejectedError ? err.code : 'IDENTITY_UNAVAILABLE';
					return { status: code === 'FORBIDDEN' ? 403 : 400, json: { ok: false, code, error: msg } };
				}
				// Once a write starts, transport failures cannot establish whether the server committed it.
				return write
					? { status: 503, json: { ok: false, code: 'DELIVERY_UNKNOWN', error: 'write result unknown locally; retain requestId and do not resend automatically', requestId: parsed.requestId } }
					: { status: 500, json: { ok: false, error: msg } };
			}
		};
		if (!write) return execute(); // Queries never consult or populate the write cache.

		// Promise is registered synchronously BEFORE the first external side effect.
		const result = Promise.resolve().then(execute);
		this.inFlight.set(key, { fingerprint, result });
		if (resetReceiptKey) this.resetReceipts.set(resetReceiptKey, result);
		void result.then((response) => {
			this.inFlight.delete(key);
			if (response.status === 503) {
				this.unknown.set(key, { fingerprint, result: response });
			} else if (response.status === 200) {
				this.completed.set(key, { fingerprint, result: response });
			} else if (resetReceiptKey) {
				this.resetReceipts.delete(resetReceiptKey); // definitive rejection: same ID may be retried after correction
			}
			// Receipts remain until daemon restart; admission cap above prevents unsafe eviction/OOM.
		});
		return result;
	}

	/** Wire node:http over a UNIX domain socket (or named pipe on win32) → handle(). */
	async listen(socketPath: string): Promise<void> {
		// Anti-spoofing: on POSIX keep the socket private — the PARENT dir must be 0700 so no other
		// user can place/replace the socket, the explicit chmod defends against the process umask
		// masking the mkdir mode bits, and the socket itself is locked to 0600 after listen(). On
		// win32 there is no fs file/dir — ownership relies on the named pipe's DEFAULT SECURITY
		// DESCRIPTOR (creator + SYSTEM + Administrators only), not on the predictable pipe name.
		prepareSocketPath(socketPath, this.platform);
		this.socketPath = socketPath;
		this.server = createServer((req, res) => {
			void (async () => {
				const body = await readJsonBody(req);
				const remoteAddress = req.socket.remoteAddress;
				const out = await this.handle({ body, remoteAddress });
				res.writeHead(out.status, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(out.json));
			})();
		});

		await new Promise<void>((resolve, reject) => {
			const onError = (err: Error) => reject(err);
			this.server!.once('error', onError);
			this.server!.listen(socketPath, () => {
				this.server!.off('error', onError);
				if (this.platform !== 'win32') {
					// Lock the bound socket to owner-only rw. A world/group-writable unix socket on a
					// shared host lets another user impersonate an aiclaw — required, not best-effort.
					chmodSync(socketPath, 0o600);
				}
				resolve();
			});
		});
	}

	async close(): Promise<void> {
		const server = this.server;
		this.server = null;
		if (server) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		if (this.platform !== 'win32' && this.socketPath && existsSync(this.socketPath)) {
			try {
				unlinkSync(this.socketPath);
			} catch {
				/* best-effort cleanup */
			}
		}
	}
}

/** Validate + coerce a raw request body into a CapabilityRequest, or undefined if malformed. */
function parseBody(body: unknown): CapabilityRequest | undefined {
	if (!body || typeof body !== 'object') return undefined;
	const b = body as Record<string, unknown>;
	if (typeof b.sessionKey !== 'string' || b.sessionKey.length === 0) return undefined;
	if (typeof b.command !== 'string' || b.command.length === 0) return undefined;
	if (b.requestId !== undefined && (typeof b.requestId !== 'string' || !b.requestId.trim() || b.requestId.length > 128)) return undefined;
	if (b.idempotencyKey !== undefined && (typeof b.idempotencyKey !== 'string' || !b.idempotencyKey.trim() || b.idempotencyKey.length > 128)) return undefined;
	if (b.requestId && b.idempotencyKey && b.requestId !== b.idempotencyKey) return undefined;
	if (b.args !== undefined && (b.args === null || typeof b.args !== 'object' || Array.isArray(b.args))) return undefined;
	return { sessionKey: b.sessionKey, command: b.command, args: (b.args ?? {}) as Record<string, unknown>, requestId: (b.requestId ?? b.idempotencyKey) as string | undefined };
}

/**
 * Sanitize an untrusted string for a ONE-LINE log field: strip CR/LF + other ASCII control chars
 * (prevents CRLF log-forgery from request-controlled `command` / session-key / capability-error
 * text — an attacker could otherwise embed `\n[capability] …` to inject a fake log line), then
 * truncate with an ellipsis. Everything logged that originates from the request body or a capability
 * error goes through here. Exported for direct unit tests.
 */
export function sanitizeLogField(s: string, max = 200): string {
	// eslint-disable-next-line no-control-regex
	const clean = s.replace(/[\x00-\x1f\x7f]/g, ' ');
	return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}

/**
 * Mask a sessionKey for logs: keep the driver prefix (`cc:`/`codex:`/`openclaw:`/`opencode:`) and FULLY
 * mask the id after the first `:` — show only its length, never any character of it. BL-014 (#141): the
 * post-`cc:`/`openclaw:` id is now an OPAQUE capability token (a credential); leaking even a head of it
 * to logs would weaken the anti-forgery guarantee, so nothing of the id is emitted. No `:` →
 * `<no-prefix>`. The result runs through sanitizeLogField so an injected CR/LF in the prefix can't forge
 * a line. Exported for direct unit tests.
 */
export function maskSessionKey(sessionKey: string): string {
	const idx = sessionKey.indexOf(':');
	if (idx === -1) return '<no-prefix>';
	const prefix = sessionKey.slice(0, idx + 1); // includes the colon
	const id = sessionKey.slice(idx + 1);
	return sanitizeLogField(`${prefix}…(${id.length})`, 64);
}

/**
 * Default socket path: AICHAT_CAPABILITY_SOCK override, else a per-platform default.
 *
 * On win32 the loopback transport is a NAMED PIPE, not a unix socket: libuv passes the path verbatim
 * to CreateNamedPipeW, so a path like `C:\…\capability.sock` (colon/backslashes) is an invalid pipe
 * name and `listen` fails EACCES. The pipe NAME is a deterministic hash of the per-user AICHAT_HOME
 * so two users on one machine land on different pipes (collision-avoidance) and the `aichat start`
 * server agrees with every `aichat send-message` CLI process. The hash is NOT a secret and provides
 * no anti-spoofing by itself — ownership comes from the named pipe's DEFAULT SECURITY DESCRIPTOR
 * (CreateNamedPipeW defaults to creator + SYSTEM + Administrators only, writable/controllable by no
 * one else). Residual risk: the name is predictable, so another local user could pre-bind it and make
 * `aichat start` fail to bind (startup DoS). Hardening — a random per-run suffix shared with the CLI
 * via a file inside AICHAT_HOME — is recorded as a future direction, not scheduled.
 */
export function capabilitySocketPath(opts?: {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	home?: string;
}): string {
	const platform = opts?.platform ?? process.platform;
	const env = opts?.env ?? process.env;
	const home = opts?.home ?? AICHAT_HOME;
	if (env.AICHAT_CAPABILITY_SOCK) return env.AICHAT_CAPABILITY_SOCK;
	if (platform === 'win32') {
		const hex = createHash('sha256').update(home).digest('hex').slice(0, 16);
		return `\\\\.\\pipe\\aichat-capability-${hex}`;
	}
	// posix.join (not join): the non-win32 branch must be host-independent — on a win32 HOST the
	// platform `join` would emit backslashes, which is only reachable here via the DI `platform` seam.
	return posix.join(home, 'capability.sock');
}

/**
 * Prepare the filesystem for a POSIX unix socket: create the parent dir (0700), re-chmod it 0700
 * (defends against a masking umask), and best-effort unlink a stale socket. NO-OP on win32 — a named
 * pipe needs no dir and is not an fs file, so mkdir/chmod/unlink are all POSIX-only.
 */
export function prepareSocketPath(socketPath: string, platform: NodeJS.Platform): void {
	if (platform === 'win32') return;
	const dir = dirname(socketPath);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	if (existsSync(socketPath)) {
		try {
			unlinkSync(socketPath);
		} catch {
			/* best-effort: a live listener will fail to bind below and surface the error */
		}
	}
}
