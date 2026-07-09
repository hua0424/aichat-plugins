import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { AICHAT_HOME } from '../config.js';

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

/** The internal (uid,room) → reverse-index key (kept identical to the legacy binding string). */
function bindingKey(aiclawUid: string, roomId: string): string {
	return `aiclaw-${aiclawUid}-room-${roomId}`;
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

	constructor(path: string = DEFAULT_BIND_TOKENS_PATH, genToken?: () => string) {
		super(genToken);
		this.path = path;
		this.load();
	}

	private load(): void {
		if (!existsSync(this.path)) return;
		try {
			const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as unknown;
			if (parsed && typeof parsed === 'object') {
				for (const [token, val] of Object.entries(parsed as Record<string, unknown>)) {
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
		} catch {
			this.forward.clear();
			this.reverse.clear();
		}
	}

	protected override afterMint(): void {
		this.persist();
	}

	private persist(): void {
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			const obj: Record<string, Bound> = {};
			for (const [token, val] of this.forward) obj[token] = val;
			writeFileSync(this.path, JSON.stringify(obj, null, 2), 'utf-8');
			// SECURITY (BL-014): the token file grants capability identity — lock it to owner-only rw.
			chmodSync(this.path, 0o600);
		} catch {
			/* best-effort: keep the in-memory map even if the disk write fails */
		}
	}
}
