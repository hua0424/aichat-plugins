import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * REQ-010 S7 / REQ-011 S2 — the claude-code (CC) hook broker.
 *
 * CC has no gateway/server: node sources a CC turn's THINKING/tool activity from claude-code **hooks**
 * that POST to this node-local HTTP broker. Each hook fires in CC's headless (`-p`) run, reads
 * `$AICHAT_BIND` (the binding string placed in CC's launch env), and POSTs to `http://127.0.0.1:<port>/`
 * with `Authorization: Bearer <AICHAT_BIND>` and a JSON hook body.
 *
 * REQ-011 S2: CC is now NODE-DRIVEN. The broker no longer drives an "external thinking" session; it
 * routes each resolved hook into the active CcHeadlessSession's AgentEvent stream via the injected
 * CcHookSink (a CcSessionRegistry bridge, src/agent/cc/sink.ts), so the handler's STANDARD path renders
 * the panel — identical to codex/opencode.
 *
 * `handle()` is the pure-ish, unit-testable core (local-only guard → Bearer extract → resolve →
 * hook-event → sink mapping). `listen()`/`close()` are a thin node:http wrapper over a 127.0.0.1 TCP
 * port that feeds parsed bodies + the Bearer token into `handle()`.
 *
 * The room/identity come ONLY from `resolve(bindToken)` — never from the hook body. A hook carries
 * only its CC session and the binding token; it can never name a room/identity it isn't bound to.
 */

/**
 * The destination for resolved CC hooks: routes them into the active node-driven CcHeadlessSession's
 * AgentEvent stream (via a CcSessionRegistry bridge). A hook for a room with no active session is a
 * safe no-op drop inside the sink (never a throw).
 */
export interface CcHookSink {
	/** PostToolUse → a `{tool}` AgentEvent for the room (name only; reduceThinking ignores tools). */
	tool(roomId: string, aiclawUid: string, toolName: string): void;
	/** MessageDisplay / assistant text → a `{thinking}` AgentEvent for the room (rendered in the panel). */
	thinking(roomId: string, aiclawUid: string, text: string): void;
	/** Stop → flush any final thinking; do NOT close — the session's `done` comes from stdout EOF. */
	flush(roomId: string, aiclawUid: string): void;
}

/** resolve() result: the bound identity + room for a binding token (REQ-029: opaque strings). */
type Resolved = { aiclawUid: string; roomId: string };

export interface CcBrokerDeps {
	/** Map a CC binding token → bound identity/room, or undefined if unknown. */
	resolve: (bindToken: string) => Resolved | undefined;
	/** Where resolved CC hooks are routed (the per-room session-stream bridge in production). */
	sink: CcHookSink;
}

/** The handle() result: an HTTP status + JSON payload. */
export interface CcBrokerResponse {
	status: number;
	json: unknown;
}

/** Loopback addresses node:http reports for local connections. */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Fixed default broker port — chunk 2's hooks config needs a known port. Env-overridable. */
const DEFAULT_BROKER_PORT = 9100;

export class CcBroker {
	private readonly resolve: (bindToken: string) => Resolved | undefined;
	private readonly sink: CcHookSink;
	private server: Server | null = null;

	constructor(deps: CcBrokerDeps) {
		this.resolve = deps.resolve;
		this.sink = deps.sink;
	}

	async handle(req: { body: unknown; remoteAddress?: string; authToken?: string }): Promise<CcBrokerResponse> {
		// Non-local guard (defense-in-depth; a local TCP connection reports a loopback address).
		if (req.remoteAddress !== undefined && !LOOPBACK.has(req.remoteAddress)) {
			return { status: 403, json: { ok: false, error: 'forbidden: non-local connection' } };
		}

		// Bearer token → resolve binding. An unknown/missing binding never emits to the sink.
		const token = req.authToken;
		if (!token) {
			return { status: 401, json: { ok: false, error: 'unauthorized: missing binding token' } };
		}
		const bound = this.resolve(token);
		if (!bound) {
			return { status: 401, json: { ok: false, error: 'unauthorized: unknown binding' } };
		}

		const hook = parseHook(req.body);
		if (!hook) {
			return { status: 400, json: { ok: false, error: 'bad request: missing hook_event_name' } };
		}

		const { roomId, aiclawUid } = bound;
		switch (hook.event) {
			case 'UserPromptSubmit':
			case 'SessionStart':
				// Lifecycle only: ignore. The handler's STANDARD node-driven path already sends
				// THINKING_START when it opens the CcHeadlessSession — no external begin needed.
				break;
			case 'PostToolUse': {
				const toolName = typeof hook.body.tool_name === 'string' ? hook.body.tool_name : 'tool';
				this.sink.tool(roomId, aiclawUid, toolName);
				break;
			}
			case 'MessageDisplay': {
				const content = typeof hook.body.content === 'string' ? hook.body.content : '';
				if (content) this.sink.thinking(roomId, aiclawUid, content);
				break;
			}
			case 'Stop':
				// last_assistant_message is the agent's thinking text, NOT the reply — the reply goes
				// through the CLI capability path, not here. Stop flushes any final thinking; it does NOT
				// close the session (the session's `done` comes from the driver's stdout EOF/`result`).
				this.sink.flush(roomId, aiclawUid);
				break;
			default:
				// A known-but-unmirrored event (or future event): accept it, route nothing.
				break;
		}

		return { status: 200, json: { ok: true } };
	}

	/** Wire node:http over a 127.0.0.1 TCP port → handle(). Parses the Bearer header + JSON body. */
	async listen(port: number = ccBrokerPort(), host = '127.0.0.1'): Promise<void> {
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
					const authToken = parseBearer(req.headers['authorization']);
					const remoteAddress = req.socket.remoteAddress;
					const out = await this.handle({ body, remoteAddress, authToken });
					res.writeHead(out.status, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify(out.json));
				})();
			});
		});

		await new Promise<void>((resolve, reject) => {
			const onError = (err: Error) => reject(err);
			this.server!.once('error', onError);
			this.server!.listen(port, host, () => {
				this.server!.off('error', onError);
				resolve();
			});
		});
	}

	/** The bound address (after listen), or null. Useful when listening on an ephemeral port (0). */
	address(): AddressInfo | null {
		const a = this.server?.address();
		return a && typeof a === 'object' ? a : null;
	}

	async close(): Promise<void> {
		const server = this.server;
		this.server = null;
		if (server) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}
}

/** A parsed hook: the event name + the raw body for per-event field access. */
interface ParsedHook {
	event: string;
	body: Record<string, unknown>;
}

/** Validate a raw hook body into { event, body }, or undefined if it carries no hook_event_name. */
function parseHook(body: unknown): ParsedHook | undefined {
	if (!body || typeof body !== 'object') return undefined;
	const b = body as Record<string, unknown>;
	if (typeof b.hook_event_name !== 'string' || b.hook_event_name.length === 0) return undefined;
	return { event: b.hook_event_name, body: b };
}

/** Extract the token from an `Authorization: Bearer <token>` header, or undefined. */
function parseBearer(header: string | undefined): string | undefined {
	if (!header) return undefined;
	const m = /^Bearer\s+(.+)$/i.exec(header.trim());
	return m ? m[1].trim() : undefined;
}

/** Default broker port: AICHAT_CC_BROKER_PORT override, else the fixed default (9100). */
export function ccBrokerPort(): number {
	const env = process.env.AICHAT_CC_BROKER_PORT;
	if (env) {
		const n = Number(env);
		if (Number.isInteger(n) && n >= 0 && n <= 65535) return n;
	}
	return DEFAULT_BROKER_PORT;
}
