import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';

/**
 * REQ-011 S2 — the node-side CC channel push endpoint (a loopback `ws` WebSocket server).
 *
 * CC inbound (a DM the agent should answer) reaches CC via claude-code's *channels* subsystem, not
 * via a node-driven turn (cc is owner-driven, `drivesTurns===false`). The bridge is a stdio MCP
 * (`aichat-channel`, src/agent/cc/channel-mcp.ts) that CC loads; that MCP opens a `ws` client to THIS
 * endpoint, subscribes with its binding token, and relays each pushed message as a `claude/channel`
 * notification into CC's session. The MessageHandler's cc DM branch calls `push(roomId, content)`.
 *
 * The room/identity come ONLY from `resolve(bindToken)` — never from the subscribe frame body. A
 * subscriber carries only its binding token; it can never name a room it isn't bound to. A loopback
 * guard (mirrors CcBroker's) rejects any non-local connection: this socket is node-local by design.
 */

/** resolve() result: the bound identity + room for a binding token. */
type Resolved = { aiclawUid: number; roomId: number };

export interface CcChannelEndpointDeps {
	/** Map a CC binding token → bound identity/room, or undefined if unknown. */
	resolve: (bindToken: string) => Resolved | undefined;
}

/** Loopback addresses node reports for local connections (same set as CcBroker). */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Fixed default channel port — the channel MCP needs a known port. Env-overridable. */
const DEFAULT_CHANNEL_PORT = 9101;

/**
 * Loopback guard: a connection whose remoteAddress is undefined OR a known loopback address is local
 * (allowed). Any other address (a real remote) is rejected. Factored out so it is unit-testable
 * directly (faking a non-loopback connection over a real 127.0.0.1 ws socket is not possible).
 */
export function isLoopback(addr?: string): boolean {
	return addr === undefined || LOOPBACK.has(addr);
}

export class CcChannelEndpoint {
	private readonly resolve: (bindToken: string) => Resolved | undefined;
	private wss: WebSocketServer | null = null;
	/** roomId → the set of subscribed sockets for that room. */
	private rooms = new Map<number, Set<WebSocket>>();

	constructor(deps: CcChannelEndpointDeps) {
		this.resolve = deps.resolve;
	}

	/** Push a message to every socket subscribed for `roomId`. No subscriber → safe no-op. */
	push(roomId: number, content: string, meta?: object): void {
		const set = this.rooms.get(roomId);
		if (!set) return;
		const frame = JSON.stringify({ type: 'message', content, ...(meta ? { meta } : {}) });
		for (const sock of set) sock.send(frame);
	}

	/** Wire a `ws` server over a 127.0.0.1 TCP port. Connections subscribe; subscriptions feed push(). */
	async listen(port: number = ccChannelPort(), host = '127.0.0.1'): Promise<void> {
		const wss = new WebSocketServer({ port, host });
		this.wss = wss;

		wss.on('connection', (sock, req) => {
			// Non-local guard (defense-in-depth; a local TCP connection reports a loopback address).
			if (!isLoopback(req.socket.remoteAddress)) {
				sock.close();
				return;
			}
			sock.on('message', (raw: Buffer) => {
				let frame: unknown;
				try {
					frame = JSON.parse(raw.toString('utf-8'));
				} catch {
					return;
				}
				if (!frame || typeof frame !== 'object') return;
				const f = frame as Record<string, unknown>;
				if (f.type !== 'subscribe' || typeof f.bindToken !== 'string') return;
				const bound = this.resolve(f.bindToken);
				if (!bound) {
					// Unknown/garbage binding → never registered; tell the client and close.
					sock.send(JSON.stringify({ type: 'error', error: 'unknown binding' }));
					sock.close();
					return;
				}
				this.register(bound.roomId, sock);
			});
			sock.on('close', () => this.deregister(sock));
		});

		await new Promise<void>((resolve, reject) => {
			const onError = (err: Error) => reject(err);
			wss.once('error', onError);
			wss.once('listening', () => {
				wss.off('error', onError);
				resolve();
			});
		});
	}

	/** Register a socket under a room set (created on first subscriber). */
	private register(roomId: number, sock: WebSocket): void {
		let set = this.rooms.get(roomId);
		if (!set) {
			set = new Set();
			this.rooms.set(roomId, set);
		}
		set.add(sock);
	}

	/** Remove a socket from every room set; drop a set once empty. */
	private deregister(sock: WebSocket): void {
		for (const [roomId, set] of this.rooms) {
			if (set.delete(sock) && set.size === 0) this.rooms.delete(roomId);
		}
	}

	/** The bound address (after listen), or null. Useful when listening on an ephemeral port (0). */
	address(): AddressInfo | null {
		const a = this.wss?.address();
		return a && typeof a === 'object' ? a : null;
	}

	async close(): Promise<void> {
		const wss = this.wss;
		this.wss = null;
		this.rooms.clear();
		if (wss) {
			await new Promise<void>((resolve) => wss.close(() => resolve()));
		}
	}
}

/** Default channel port: AICHAT_CC_CHANNEL_PORT override, else the fixed default (9101). */
export function ccChannelPort(): number {
	const env = process.env.AICHAT_CC_CHANNEL_PORT;
	if (env) {
		const n = Number(env);
		if (Number.isInteger(n) && n >= 0 && n <= 65535) return n;
	}
	return DEFAULT_CHANNEL_PORT;
}
