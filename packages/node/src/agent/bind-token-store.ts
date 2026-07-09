import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { AICHAT_HOME } from '../config.js';
import { readJsonMap, AsyncJsonWriter } from './file-map-store.js';

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

/** Default location: persists under ~/.aichat/ (a persistent volume) so tokens survive restarts. */
export const DEFAULT_BIND_TOKENS_PATH = join(AICHAT_HOME, 'bind-tokens.json');

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
		this.afterMint();
		return token;
	}

	resolve(token: string): { aiclawUid: string; roomId: string } | undefined {
		if (!token) return undefined;
		// #161: openclaw lowercases the sessionKey, so normalize the input before lookup (tokens are stored lowercase).
		const v = this.forward.get(token.toLowerCase());
		return v ? { aiclawUid: v.aiclawUid, roomId: v.roomId } : undefined;
	}

	/** Hook: FileBindTokenStore persists here. In-memory is a no-op. */
	protected afterMint(): void {
		/* no-op */
	}
}

/**
 * File-backed BindTokenStore. Loads once on construction (rebuilding the reverse index), then persists
 * the whole forward map on every mint. The token file is a SENSITIVE credential — on every persist we
 * mkdir the dir, write, then chmod 0600. Read/parse failures degrade to an empty map (never crash the
 * node). Structure mirrors FileCodexSessionStore / FileCcHeadlessSessionStore.
 */
export class FileBindTokenStore extends InMemoryBindTokenStore {
	private readonly path: string;
	// aichatoverview#166: async + serialized + mkdir-once (0600). mint is already low-frequency (only a NEW
	// (uid,room) persists), so this mainly removes the per-persist sync mkdir + write off the event loop.
	private readonly writer: AsyncJsonWriter;

	constructor(path: string = DEFAULT_BIND_TOKENS_PATH, genToken?: () => string) {
		super(genToken);
		this.path = path;
		this.writer = new AsyncJsonWriter(path, 0o600);
		this.load();
	}

	private load(): void {
		// Shared read primitive ({} on missing/parse-fail); the dual-map + normalization below is
		// bind-specific (a distinct security path, NOT the session stores' copy).
		for (const [token, val] of Object.entries(readJsonMap<unknown>(this.path))) {
			if (val && typeof val === 'object') {
				const b = val as Record<string, unknown>;
				// REQ-029 (#29): uid/room are opaque strings — accept only string fields.
				if (typeof b.aiclawUid === 'string' && typeof b.roomId === 'string') {
					// #161 P1: a token file written before the lowercase-normalization stored the token
					// key raw (mixed case). resolve()/mint() operate in lowercase, so normalize the key
					// on load — otherwise resolve(token.toLowerCase()) would miss the mixed-case entry.
					const key = token.toLowerCase();
					this.forward.set(key, { aiclawUid: b.aiclawUid, roomId: b.roomId });
					this.reverse.set(bindingKey(b.aiclawUid, b.roomId), key);
				}
			}
		}
	}

	protected override afterMint(): void {
		this.persist();
	}

	private persist(): void {
		const obj: Record<string, Bound> = {};
		for (const [token, val] of this.forward) obj[token] = val;
		// SECURITY (BL-014): the token file grants capability identity — locked to owner-only rw (0600) by the writer.
		this.writer.write(obj);
	}

	/** Resolve when all queued async persists have drained (tests / graceful shutdown). */
	whenPersisted(): Promise<void> {
		return this.writer.whenWritten();
	}
}
