import { join } from 'node:path';
import { AICHAT_HOME } from '../../config.js';
import { FileJsonMapStore } from '../file-map-store.js';

/** A persisted CC headless session binding: which claude `session_id` is bound to a (uid, room) key. */
export interface StoredCcHeadlessSession {
	sessionId: string;
}

/**
 * REQ-011 S2 — injectable persisted map `key -> {sessionId}` for cross-turn/restart `--resume` of the
 * node-driven claude-code headless turn. Tests use an in-memory fake; production uses the file-backed
 * impl below.
 *
 * Forward-only BY DESIGN, and keyed by the INTERNAL binding string `aiclaw-{uid}-room-{roomId}` (which
 * the node retains for its own keying — it is NOT the opaque bind-token used for capability identity, a
 * separate concern in `BindTokenStore`). The store is consulted ONLY by that forward key to reuse a
 * `session_id` for `--resume` on the next turn of the same (aiclawUid, roomId); it needs no reverse lookup.
 * (Codex differs: it gets `CODEX_THREAD_ID`, not the binding, so it must reverse-look-up the (uid, room).)
 */
export interface CcHeadlessSessionStore {
	get(key: string): StoredCcHeadlessSession | undefined;
	set(key: string, val: StoredCcHeadlessSession): void;
	/** Drop a binding — used by resetSession and the dead-`--resume` self-heal to clear a stale sessionId. */
	delete(key: string): void;
}

/** Default location: persists under ~/.aichat/ (a persistent volume) so reuse survives restarts. */
export const DEFAULT_CC_SESSIONS_PATH = join(AICHAT_HOME, 'cc', 'sessions.json');

/**
 * File-backed CcHeadlessSessionStore (a tiny JSON object map). Loads once on construction; each set()
 * writes the whole map back (the map is small — one entry per (aiclawUid, roomId) pair).
 * Read/parse/write failures degrade to an empty/no-op store rather than crashing the node.
 */
export class FileCcHeadlessSessionStore implements CcHeadlessSessionStore {
	private readonly store: FileJsonMapStore<StoredCcHeadlessSession>;

	constructor(path: string = DEFAULT_CC_SESSIONS_PATH) {
		this.store = new FileJsonMapStore(path, (v) => typeof v.sessionId === 'string');
	}

	get(key: string): StoredCcHeadlessSession | undefined {
		return this.store.get(key);
	}

	set(key: string, val: StoredCcHeadlessSession): void {
		this.store.set(key, val);
	}

	delete(key: string): void {
		this.store.delete(key);
	}

	/** aichatoverview#166: await the async persist chain (tests / graceful shutdown). */
	whenPersisted(): Promise<void> {
		return this.store.whenPersisted();
	}
}
