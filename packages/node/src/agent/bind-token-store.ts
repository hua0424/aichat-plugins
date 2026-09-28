import { randomBytes } from 'node:crypto';

/**
 * BL-014 (#141) — opaque agent-facing binding token.
 *
 * openclaw/cc used to inject the PLAINTEXT binding string `aiclaw-{uid}-room-{roomId}` as the agent's
 * env value (`OPENCLAW_BIND` / `AICHAT_BIND`); resolveSession just regex-parsed it. An agent with bash
 * could overwrite that env var to FORGE any (uid,room) and call capabilities as another identity/room.
 *
 * This store replaces the agent-facing value with a node-minted OPAQUE random token, backed by a
 * persisted `token → (uid,room)` map; `resolveSession` looks the token up instead of parsing. A forged
 * plaintext binding never appears in the map → resolve returns undefined → the capability endpoint 404s.
 *
 * The internal binding string is retained everywhere it stays inside the node (cc session_id keying,
 * transcript, room registry, resetSession) — those never leave the node, so they carry no forgery risk.
 */
export interface BindTokenStore {
	/** Return the STABLE token for (uid,room): reuse the existing one if present, else mint+persist a new one. */
	mint(aiclawUid: string, roomId: string): string;
	/** Reverse: opaque token → bound identity+room, or undefined if unknown/garbage. */
	resolve(token: string): { aiclawUid: string; roomId: string } | undefined;
}

/** The persisted per-token value. */
interface Bound {
	aiclawUid: string;
	roomId: string;
}

/**
 * The internal (uid,room) → binding string `aiclaw-{uid}-room-{roomId}` — the node's per-(uid,room)
 * key for session stores / reverse index / cc session_id keying / the openclaw compound sessionKey.
 * Single-sourced (aichatoverview#165): every driver + the handler build the key here, not inline.
 */
export function bindingKey(aiclawUid: string, roomId: string): string {
	return `aiclaw-${aiclawUid}-room-${roomId}`;
}

/** Inverse of {@link bindingKey}: parse a binding string back to (uid,room), or undefined if malformed. */
export function parseBindingKey(key: string): { aiclawUid: string; roomId: string } | undefined {
	const m = /^aiclaw-(\d+)-room-(\d+)$/.exec(key);
	// REQ-029 (#29): opaque strings, never Number() (>2^53 corrupts routing).
	return m ? { aiclawUid: m[1], roomId: m[2] } : undefined;
}

/**
 * Default token: 32 random bytes → hex (64 lowercase chars, still 256-bit / unguessable / non-enumerable).
 * Hex is lowercase-native so openclaw's sessionKey-lowercasing (#161) is a no-op on the round-trip.
 */
function defaultGenToken(): string {
	return randomBytes(32).toString('hex');
}

/**
 * In-memory BindTokenStore. Holds the forward map `token → {aiclawUid,roomId}` PLUS a reverse index
 * `bindingKey → token`, so `mint` is STABLE per (uid,room): a second mint of the same pair returns the
 * SAME token (openclaw/cc conversation continuity depends on a stable sessionKey — a per-turn-new token
 * would reset the conversation). Also used directly as an injectable fake in other tests.
 */
export class InMemoryBindTokenStore implements BindTokenStore {
	/** forward map: token → bound identity+room (the persisted shape). */
	protected readonly forward = new Map<string, Bound>();
	/** reverse index: bindingKey → token; rebuilt on load; makes mint idempotent per (uid,room). */
	protected readonly reverse = new Map<string, string>();
	protected readonly genToken: () => string;

	constructor(genToken: () => string = defaultGenToken) {
		this.genToken = genToken;
	}

	mint(aiclawUid: string, roomId: string): string {
		const bkey = bindingKey(aiclawUid, roomId);
		const existing = this.reverse.get(bkey);
		// #161 P1: normalize on the reuse path too — a token loaded from an old (pre-normalization)
		// file may be mixed-case; return it lowercased so callers get the same form resolve() keys on.
		if (existing) return existing.toLowerCase(); // stable: reuse the token already minted for this (uid,room)
		// #161: openclaw lowercases the sessionKey it echoes back through resolve_exec_env, so store
		// and return the token in normalized (lowercase) form → the received token matches the store key.
		const token = this.genToken().toLowerCase();
		this.forward.set(token, { aiclawUid, roomId });
		this.reverse.set(bkey, token);
		return token;
	}

	resolve(token: string): { aiclawUid: string; roomId: string } | undefined {
		if (!token) return undefined;
		// #161: openclaw lowercases the sessionKey, so normalize the input before lookup (tokens are stored lowercase).
		const v = this.forward.get(token.toLowerCase());
		return v ? { aiclawUid: v.aiclawUid, roomId: v.roomId } : undefined;
	}
}
