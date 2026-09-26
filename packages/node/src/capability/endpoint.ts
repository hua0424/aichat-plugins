import { createServer, type Server } from 'node:http';
import { createConnection } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { readJsonBody } from '../util/http-body.js';
import { unlinkSync, existsSync, mkdirSync, chmodSync, openSync, writeSync, closeSync, readFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { AICHAT_HOME } from '../config.js';
import { CapabilityRejectedError, type CapabilityRegistry, type CapabilityContext } from './registry.js';
import { HulaApiRejectedError, type HulaApiClient } from '../api/hula-api.js';
import { parseSessionKey } from './session-key.js';
import { errMsg } from '../util/err.js';

/** The resolve() result: the bound identity+room + the per-identity api client (REQ-029: opaque strings). */
type Resolved = { aiclawUid: string; roomId: string; apiClient: HulaApiClient };
export type ContextCandidate = { key: string } | { provider: string; nativeId: string; runtimeScope?: string };
export type ResolvedCandidate = Resolved & { conversationId: string; generation: number };

export interface CapabilityEndpointDeps {
	registry: CapabilityRegistry;
	/** Map an agent session key → bound identity/room/api, or undefined if unknown. */
	resolve: (sessionKey: string) => Resolved | undefined;
	/** Core-owned exact candidate lookup; all V2 candidates must resolve to the same binding. */
	resolveCandidate?: (candidate: ContextCandidate) => ResolvedCandidate | undefined;
	/** All endpoints using the same AICHAT_HOME share one writer lock, even with different socket overrides. */
	lockHome?: string;
	/** Namespaces request IDs to this configured server, not another backend. */
	serverNamespace?: string;
	/** Maximum admitted local write IDs; reject NEW IDs when full rather than evict safely recorded ones. */
	maxWriteIds?: number;
	/** Durable reset-only receipt lookup before revoked bearer resolution. */
	getResetReceipt?: (bearer: string, requestId: string) => { reset: true; generation: number; executionPaused: boolean } | undefined;
	/** Core conversation state, never inferred from a caller-supplied room. */
	isPaused?: (uid: string, roomId: string) => boolean;
	/** Stop the old run only after the reset HTTP response has left this process. */
	onResetDelivered?: (uid: string, roomId: string, previousRunId?: string) => void;
	/** Test seam: force win32 behavior (named pipe, skip POSIX chmod/cleanup) on any host. */
	platform?: NodeJS.Platform;
}

/** A parsed capability request body. */
interface CapabilityRequest {
	sessionKey?: string;
	contexts?: ContextCandidate[];
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
	private readonly resolveCandidate?: (candidate: ContextCandidate) => ResolvedCandidate | undefined;
	/** In-flight writes remain registered until resolution, even when completed receipts reach the cap. */
	private readonly inFlight = new Map<string, { fingerprint: string; result: Promise<CapabilityResponse> }>();
	private readonly completed = new Map<string, { fingerprint: string; result: CapabilityResponse }>();
	/** An unknown result must never be evicted as if the write had not happened. */
	private readonly unknown = new Map<string, { fingerprint: string; result: CapabilityResponse }>();
	/** Minimal reset receipt survives its own removal of the bound native session. */
	private readonly resetReceipts = new Map<string, Promise<CapabilityResponse>>();
	private readonly roomGeneration = new Map<string, number>();
	private readonly serverNamespace: string;
	private readonly lockHome?: string;
	private readonly maxWriteIds: number;
	private readonly getResetReceipt?: CapabilityEndpointDeps['getResetReceipt'];
	private readonly isPaused?: (uid: string, roomId: string) => boolean;
	private readonly onResetDelivered?: CapabilityEndpointDeps['onResetDelivered'];
	private readonly delivery = new WeakMap<CapabilityResponse, () => void>();
	/** POSIX fs guards (dir/socket chmod, stale unlink) apply only on non-win32. */
	private readonly platform: NodeJS.Platform;
	private server: Server | null = null;
	private socketPath: string | null = null;
	private socketIdentity: { dev: number; ino: number } | null = null;
	private lockPath: string | null = null;
	private lockToken: string | null = null;

	constructor(deps: CapabilityEndpointDeps) {
		this.registry = deps.registry;
		this.resolve = deps.resolve;
		this.resolveCandidate = deps.resolveCandidate;
		this.serverNamespace = deps.serverNamespace ?? '';
		this.lockHome = deps.lockHome;
		this.maxWriteIds = deps.maxWriteIds ?? 100_000;
		this.getResetReceipt = deps.getResetReceipt;
		this.isPaused = deps.isPaused;
		this.onResetDelivered = deps.onResetDelivered;
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

		const logKey = parsed.sessionKey ? maskSessionKey(parsed.sessionKey) : '<v2>';
		// Legacy callers keep their exact original prefix and resolution contract.
		if (parsed.sessionKey && !parseSessionKey(parsed.sessionKey)) {
			console.log(`[capability] ${sanitizeLogField(parsed.command, 64)} ${logKey} → (unresolved) err=unknown session key prefix`);
			return { status: 400, json: { ok: false, error: 'unknown or missing session key prefix' } };
		}

		// A reset may retrieve ONLY its minimal receipt under the same bearer and request ID.
		const resetReceiptKey = parsed.command === 'reset-session' && parsed.requestId
			? JSON.stringify([parsed.sessionKey ?? parsed.contexts, parsed.requestId]) : undefined;
		if (resetReceiptKey) {
			const receipt = this.resetReceipts.get(resetReceiptKey);
			let durable: ReturnType<NonNullable<CapabilityEndpointDeps['getResetReceipt']>>;
			try { durable = this.getResetReceipt?.(JSON.stringify(parsed.sessionKey ?? parsed.contexts), parsed.requestId!); }
			catch { return { status: 503, json: { ok: false, code: 'PERSISTENCE_FAILED', error: 'reset receipt lookup unavailable' } }; }
			if (receipt || durable) return Object.keys(parsed.args).length
				? { status: 409, json: { ok: false, code: 'IDEMPOTENCY_CONFLICT', error: 'requestId used with different write' } }
				: receipt ?? { status: 200, json: { ok: true, result: durable } };
		}
		let resolved: Resolved | undefined;
		let generation: number | undefined;
		if (parsed.contexts) {
			let first: ResolvedCandidate | undefined;
			for (const candidate of parsed.contexts) {
				let current: ResolvedCandidate | undefined;
				try { current = this.resolveCandidate?.(candidate); } catch { /* broken index must fail closed */ }
				if (!current || !Number.isSafeInteger(current.generation) || current.generation < 1 ||
					!current.conversationId || !current.aiclawUid || !current.roomId ||
					(first && (first.conversationId !== current.conversationId || first.generation !== current.generation ||
						first.aiclawUid !== current.aiclawUid || first.roomId !== current.roomId))) {
					return { status: 409, json: { ok: false, code: 'AMBIGUOUS_CONTEXT', error: 'unresolved or conflicting context candidates' } };
				}
				first = current;
			}
			resolved = first;
			generation = first?.generation;
		} else {
			resolved = this.resolve(parsed.sessionKey!);
		}
		if (!resolved) {
			console.log(`[capability] ${sanitizeLogField(parsed.command, 64)} ${logKey} → (unresolved) err=unknown session`);
			return { status: 404, json: { ok: false, code: 'CONTEXT_REVOKED', error: 'unknown session' } };
		}
		if (parsed.command === 'send-message' && this.isPaused?.(resolved.aiclawUid, resolved.roomId)) {
			return { status: 409, json: { ok: false, code: 'STOP_UNCONFIRMED', error: 'conversation execution paused pending stop confirmation' } };
		}

		if (!this.registry.has(parsed.command)) {
			// Failure path — AC "成功/失败都有" covers it. command failed the registry whitelist → untrusted,
			// sanitize. uid/room are known here (session resolved), so log the full locator.
			console.log(
				`[capability] ${sanitizeLogField(parsed.command, 64)} ${logKey} → (uid=${resolved.aiclawUid}, room=${resolved.roomId}) err=unknown command`,
			);
			return { status: 400, json: { ok: false, error: `unknown command: ${parsed.command}` } };
		}

		const ctx: CapabilityContext = {
			aiclawUid: resolved.aiclawUid,
			roomId: resolved.roomId,
			apiClient: resolved.apiClient,
			...(parsed.command === 'reset-session' ? {
				requestId: parsed.requestId,
				resetBearer: JSON.stringify(parsed.sessionKey ?? parsed.contexts),
			} : {}),
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
			parsed.command, resolved.roomId, generation ?? this.roomGeneration.get(roomKey) ?? 0,
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
		const loc = `[capability] ${sanitizeLogField(parsed.command, 64)} ${logKey} → (uid=${resolved.aiclawUid}, room=${resolved.roomId})`;
		const execute = async (): Promise<CapabilityResponse> => {
			try {
				const result = await this.registry.invoke(parsed.command, ctx, parsed.args);
				if (parsed.command === 'reset-session' && (result as { reset?: boolean })?.reset) {
					// Local generation changes only on a confirmed reset of this room.
					this.roomGeneration.set(roomKey, (this.roomGeneration.get(roomKey) ?? 0) + 1);
				}
				console.log(`${loc} ok`);
				// The revoked bearer can replay only this operation's minimal receipt, never another cached result.
				const receipt = parsed.command === 'reset-session' ? {
					reset: (result as { reset?: boolean })?.reset === true,
					...((result as { generation?: number })?.generation === undefined ? {} : {
						generation: (result as { generation: number }).generation,
						executionPaused: (result as { executionPaused?: boolean }).executionPaused === true,
					}),
				} : result;
				const response: CapabilityResponse = { status: 200, json: { ok: true, result: receipt } };
				if (parsed.command === 'reset-session' && (result as { reset?: boolean })?.reset) {
					this.delivery.set(response, () => this.onResetDelivered?.(resolved.aiclawUid, resolved.roomId,
						(result as { cancelRunId?: string }).cancelRunId));
				}
				return response;
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
		if (this.server || this.lockToken) throw new Error('capability endpoint already listening');
		prepareSocketPath(socketPath, this.platform);
		// Exclusive creation serializes startup across node processes, including the stale-socket probe.
		// An unambiguous dead owner can be reclaimed; unknown liveness fails closed.
		if (this.lockHome) {
			mkdirSync(this.lockHome, { recursive: true, mode: 0o700 });
			if (this.platform !== 'win32') chmodSync(this.lockHome, 0o700);
		}
		const lockPath = this.lockHome ? join(this.lockHome, 'conversation-writer.lock') : this.platform === 'win32'
			? join(tmpdir(), `aichat-capability-${createHash('sha256').update(socketPath).digest('hex')}.lock`)
			: `${socketPath}.lock`;
		const token = `${process.pid}:${randomUUID()}`;
		let fd: number;
		try {
			fd = openSync(lockPath, 'wx', 0o600);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
			await reclaimDeadLock(lockPath, socketPath);
			fd = openSync(lockPath, 'wx', 0o600);
		}
		try { writeSync(fd, token); } finally { closeSync(fd); }
		this.lockPath = lockPath;
		this.lockToken = token;
		try {
			if (this.platform !== 'win32' && existsSync(socketPath)) {
				const old = lstatSync(socketPath);
				if (!old.isSocket()) throw new Error('capability socket path is not a socket');
				if (await socketAcceptsConnections(socketPath)) throw new Error('capability socket already has a live listener');
				const current = lstatSync(socketPath);
				if (old.dev !== current.dev || old.ino !== current.ino) throw new Error('capability socket changed during startup');
				unlinkSync(socketPath);
			}
			const server = createServer((req, res) => {
				void (async () => {
					const body = await readJsonBody(req);
					const out = await this.handle({ body, remoteAddress: req.socket.remoteAddress });
					res.writeHead(out.status, { 'Content-Type': 'application/json' });
					res.once('finish', () => {
						const afterDelivery = this.delivery.get(out);
						if (afterDelivery) { this.delivery.delete(out); afterDelivery(); }
					});
					res.end(JSON.stringify(out.json));
				})();
			});
			this.server = server;
			await new Promise<void>((resolve, reject) => {
				const onError = (err: Error) => { server.off('error', onError); reject(err); };
				server.once('error', onError);
				server.listen(socketPath, () => {
					server.off('error', onError);
					try {
						if (this.platform !== 'win32') chmodSync(socketPath, 0o600);
						resolve();
					} catch (err) { reject(err); }
				});
			});
			this.socketPath = socketPath;
			if (this.platform !== 'win32') {
				const stat = lstatSync(socketPath);
				this.socketIdentity = { dev: stat.dev, ino: stat.ino };
			}
		} catch (err) {
			await this.close();
			throw err;
		}
	}

	async close(): Promise<void> {
		const server = this.server;
		this.server = null;
		if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
		if (this.platform !== 'win32' && this.socketPath && this.socketIdentity) {
			try {
				const stat = lstatSync(this.socketPath);
				if (stat.dev === this.socketIdentity.dev && stat.ino === this.socketIdentity.ino) unlinkSync(this.socketPath);
			} catch { /* removed/replaced by another process: never delete its socket */ }
		}
		this.socketPath = null;
		this.socketIdentity = null;
		if (this.lockPath && this.lockToken) {
			try { if (readFileSync(this.lockPath, 'utf8') === this.lockToken) unlinkSync(this.lockPath); }
			catch { /* ownership changed or already removed */ }
		}
		this.lockPath = null;
		this.lockToken = null;
	}
}

/** Never reclaim a live/unknown writer's lock. A dead PID plus a non-listening endpoint is required. */
async function reclaimDeadLock(lockPath: string, socketPath: string): Promise<void> {
	const old = lstatSync(lockPath);
	const value = readFileSync(lockPath, 'utf8');
	const match = /^(\d+):[0-9a-f-]+$/.exec(value);
	if (!match) throw new Error('capability lock owner unknown');
	try {
		process.kill(Number(match[1]), 0);
		throw new Error('capability endpoint writer already running');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
	}
	try {
		if (await socketAcceptsConnections(socketPath)) throw new Error('capability socket already has a live listener');
	} catch (err) {
		// Missing pipe/socket and an explicitly refused stale socket both indicate no listener.
		if (!['ENOENT', 'ECONNREFUSED'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
	}
	const current = lstatSync(lockPath);
	if (old.dev !== current.dev || old.ino !== current.ino || readFileSync(lockPath, 'utf8') !== value)
		throw new Error('capability lock changed during recovery');
	unlinkSync(lockPath);
}

/** Only ECONNREFUSED proves a leftover socket; all other probe errors fail closed. */
function socketAcceptsConnections(path: string): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(path);
		socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('capability socket probe timed out')); });
		socket.once('connect', () => { socket.destroy(); resolve(true); });
		socket.once('error', (err: NodeJS.ErrnoException) => {
			if (err.code === 'ECONNREFUSED') resolve(false);
			else reject(err);
		});
	});
}

/** Validate + coerce a raw request body into a CapabilityRequest, or undefined if malformed. */
function parseBody(body: unknown): CapabilityRequest | undefined {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
	const b = body as Record<string, unknown>;
	if (typeof b.command !== 'string' || !b.command || b.command.length > 128) return undefined;
	if (b.requestId !== undefined && (typeof b.requestId !== 'string' || !b.requestId.trim() || b.requestId.length > 128)) return undefined;
	if (b.idempotencyKey !== undefined && (typeof b.idempotencyKey !== 'string' || !b.idempotencyKey.trim() || b.idempotencyKey.length > 128)) return undefined;
	if (b.requestId && b.idempotencyKey && b.requestId !== b.idempotencyKey) return undefined;
	if (b.args !== undefined && (b.args === null || typeof b.args !== 'object' || Array.isArray(b.args))) return undefined;
	const args = (b.args ?? {}) as Record<string, unknown>;
	const requestId = (b.requestId ?? b.idempotencyKey) as string | undefined;
	if (b.version === 2) {
		if (b.sessionKey !== undefined || !Array.isArray(b.contexts) || b.contexts.length < 1 || b.contexts.length > 8 ||
			['uid', 'room', 'roomId', 'aiclawUid', 'identityId'].some((field) => field in b)) return undefined;
		const contexts: ContextCandidate[] = [];
		for (const item of b.contexts) {
			if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
			const c = item as Record<string, unknown>;
			if ('key' in c) {
				if (Object.keys(c).length !== 1 || typeof c.key !== 'string' || !c.key || c.key.length > 256) return undefined;
				contexts.push({ key: c.key });
			} else {
				if (Object.keys(c).some((field) => !['provider', 'nativeId', 'runtimeScope'].includes(field)) ||
					typeof c.provider !== 'string' || !c.provider || c.provider.length > 32 ||
					typeof c.nativeId !== 'string' || !c.nativeId || c.nativeId.length > 512 ||
					(c.runtimeScope !== undefined && (typeof c.runtimeScope !== 'string' || !c.runtimeScope || c.runtimeScope.length > 256))) return undefined;
				contexts.push({ provider: c.provider, nativeId: c.nativeId, ...(c.runtimeScope === undefined ? {} : { runtimeScope: c.runtimeScope as string }) });
			}
		}
		if (b.command === 'send-message' && ['uid', 'room', 'roomId', 'aiclawUid', 'identityId', 'fromUid'].some((field) => field in args)) return undefined;
		return { contexts, command: b.command, args, requestId };
	}
	if (b.version !== undefined || b.contexts !== undefined || typeof b.sessionKey !== 'string' || !b.sessionKey || b.sessionKey.length > 512) return undefined;
	return { sessionKey: b.sessionKey, command: b.command, args, requestId };
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

/** Prepare private POSIX parent, never delete an unprobed socket (including an active listener). */
export function prepareSocketPath(socketPath: string, platform: NodeJS.Platform): void {
	if (platform === 'win32') return;
	const dir = dirname(socketPath);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
}
