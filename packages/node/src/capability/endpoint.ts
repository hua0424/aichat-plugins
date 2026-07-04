import { createServer, type Server } from 'node:http';
import { unlinkSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { AICHAT_HOME } from '../config.js';
import type { CapabilityRegistry, CapabilityContext } from './registry.js';
import type { HulaApiClient } from '../api/hula-api.js';
import { parseSessionKey } from './session-key.js';

/** The resolve() result: the bound identity+room + the per-identity api client (REQ-029: opaque strings). */
type Resolved = { aiclawUid: string; roomId: string; apiClient: HulaApiClient };

export interface CapabilityEndpointDeps {
	registry: CapabilityRegistry;
	/** Map an agent session key → bound identity/room/api, or undefined if unknown. */
	resolve: (sessionKey: string) => Resolved | undefined;
	/** Max idempotency cache entries before FIFO-evicting the oldest (default 1000). */
	idempotencyCap?: number;
}

/** Default cap on the idempotency cache; evict oldest (FIFO) past this in a long-lived daemon. */
const DEFAULT_IDEMPOTENCY_CAP = 1000;

/** A parsed capability request body. */
interface CapabilityRequest {
	sessionKey: string;
	command: string;
	args: Record<string, unknown>;
	idempotencyKey: string;
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
 * `handle()` is the pure-ish, unit-testable core: it holds the idempotency cache and applies the
 * local-only guard / resolve / dedup / dispatch rules. `listen()`/`close()` are a thin node:http
 * wrapper over a UNIX domain socket that feeds bodies into `handle()`.
 *
 * Anti-spoofing: the room/identity are taken ONLY from `resolve(sessionKey)` — never from the
 * request args. The agent's CLI carries only its session id, never room/identity.
 */
export class CapabilityEndpoint {
	private readonly registry: CapabilityRegistry;
	private readonly resolve: (sessionKey: string) => Resolved | undefined;
	/** (sessionKey idempotencyKey) → the prior response, so a repeat never re-invokes. */
	private readonly idempotency = new Map<string, CapabilityResponse>();
	/** FIFO cap on `idempotency`: every call uses a fresh idempotencyKey, so the Map would leak forever. */
	private readonly idempotencyCap: number;
	private server: Server | null = null;
	private socketPath: string | null = null;

	constructor(deps: CapabilityEndpointDeps) {
		this.registry = deps.registry;
		this.resolve = deps.resolve;
		this.idempotencyCap = deps.idempotencyCap ?? DEFAULT_IDEMPOTENCY_CAP;
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

		// Idempotency: a repeat of (sessionKey, idempotencyKey) returns the prior response verbatim,
		// WITHOUT re-invoking the capability.
		const cacheKey = `${parsed.sessionKey} ${parsed.idempotencyKey}`;
		const cached = this.idempotency.get(cacheKey);
		if (cached) return cached;

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

		// One structured line per real resolution+invocation outcome (REQ-013 style: one line, key
		// locating fields, content truncated). No args (may hold message content), no idempotencyKey,
		// masked sessionKey, truncated error text — no credential/token leak.
		// command is whitelist-validated here (registry.has passed), but sanitize anyway for consistency.
		const loc = `[capability] ${sanitizeLogField(parsed.command, 64)} ${maskSessionKey(parsed.sessionKey)} → (uid=${resolved.aiclawUid}, room=${resolved.roomId})`;
		let response: CapabilityResponse;
		try {
			const result = await this.registry.invoke(parsed.command, ctx, parsed.args);
			response = { status: 200, json: { ok: true, result } };
			console.log(`${loc} ok`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			response = { status: 500, json: { ok: false, error: msg } };
			// capability error text is untrusted (may contain CR/LF) → sanitize + truncate.
			console.log(`${loc} err=${sanitizeLogField(msg)}`);
		}

		// Cache the resolved outcome (success OR failure) so a retried idempotencyKey is stable.
		// FIFO-evict the oldest past the cap: a Map preserves insertion order, so .keys().next()
		// is the oldest entry. Without this the cache leaks forever in a long-lived `aichat start`.
		this.idempotency.set(cacheKey, response);
		if (this.idempotency.size > this.idempotencyCap) {
			const oldest = this.idempotency.keys().next().value;
			if (oldest !== undefined) this.idempotency.delete(oldest);
		}
		return response;
	}

	/** Wire node:http over a UNIX domain socket → handle(). Best-effort unlink a stale socket first. */
	async listen(socketPath: string): Promise<void> {
		// Anti-spoofing: keep the socket private. The PARENT dir must be 0700 so no other user can
		// place/replace the socket; the explicit chmod defends against the process umask masking the
		// mkdir mode bits. The socket itself is locked to 0600 after listen() below.
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
		this.socketPath = socketPath;
		this.server = createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on('data', (c: Buffer) => chunks.push(c));
			req.on('end', () => {
				void (async () => {
					let body: unknown;
					try {
						body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : {};
					} catch {
						body = undefined;
					}
					const remoteAddress = req.socket.remoteAddress;
					const out = await this.handle({ body, remoteAddress });
					res.writeHead(out.status, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify(out.json));
				})();
			});
		});

		await new Promise<void>((resolve, reject) => {
			const onError = (err: Error) => reject(err);
			this.server!.once('error', onError);
			this.server!.listen(socketPath, () => {
				this.server!.off('error', onError);
				// Lock the bound socket to owner-only rw. A world/group-writable unix socket on a shared
				// host lets another user impersonate an aiclaw — required, not best-effort.
				chmodSync(socketPath, 0o600);
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
		if (this.socketPath && existsSync(this.socketPath)) {
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
	if (typeof b.idempotencyKey !== 'string' || b.idempotencyKey.length === 0) return undefined;
	const args = b.args && typeof b.args === 'object' ? (b.args as Record<string, unknown>) : {};
	return { sessionKey: b.sessionKey, command: b.command, args, idempotencyKey: b.idempotencyKey };
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

/** Default socket path: AICHAT_CAPABILITY_SOCK override, else ~/.aichat/capability.sock. */
export function capabilitySocketPath(): string {
	return process.env.AICHAT_CAPABILITY_SOCK || join(AICHAT_HOME, 'capability.sock');
}
