import { createServer, type Server } from 'node:http';
import { unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { AICHAT_HOME } from '../config.js';
import type { CapabilityRegistry, CapabilityContext } from './registry.js';
import type { HulaApiClient } from '../api/hula-api.js';

/** The resolve() result: the bound identity+room + the per-identity api client. */
type Resolved = { aiclawUid: number; roomId: number; apiClient: HulaApiClient };

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

		// Idempotency: a repeat of (sessionKey, idempotencyKey) returns the prior response verbatim,
		// WITHOUT re-invoking the capability.
		const cacheKey = `${parsed.sessionKey} ${parsed.idempotencyKey}`;
		const cached = this.idempotency.get(cacheKey);
		if (cached) return cached;

		const resolved = this.resolve(parsed.sessionKey);
		if (!resolved) {
			// not cached — an unresolved session is transient (could resolve next time)
			return { status: 404, json: { ok: false, error: 'unknown session' } };
		}

		if (!this.registry.has(parsed.command)) {
			return { status: 400, json: { ok: false, error: `unknown command: ${parsed.command}` } };
		}

		const ctx: CapabilityContext = {
			aiclawUid: resolved.aiclawUid,
			roomId: resolved.roomId,
			apiClient: resolved.apiClient,
		};

		let response: CapabilityResponse;
		try {
			const result = await this.registry.invoke(parsed.command, ctx, parsed.args);
			response = { status: 200, json: { ok: true, result } };
		} catch (err) {
			response = { status: 500, json: { ok: false, error: err instanceof Error ? err.message : String(err) } };
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

/** Default socket path: AICHAT_CAPABILITY_SOCK override, else ~/.aichat/capability.sock. */
export function capabilitySocketPath(): string {
	return process.env.AICHAT_CAPABILITY_SOCK || join(AICHAT_HOME, 'capability.sock');
}
