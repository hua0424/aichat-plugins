import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { AICHAT_HOME } from '../../config.js';

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
	private map: Record<string, StoredCcHeadlessSession> = {};

	constructor(private readonly path: string = DEFAULT_CC_SESSIONS_PATH) {
		this.load();
	}

	private load(): void {
		if (!existsSync(this.path)) return;
		try {
			const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as unknown;
			if (parsed && typeof parsed === 'object') {
				this.map = parsed as Record<string, StoredCcHeadlessSession>;
			}
		} catch {
			this.map = {};
		}
	}

	get(key: string): StoredCcHeadlessSession | undefined {
		const v = this.map[key];
		if (v && typeof v.sessionId === 'string') return v;
		return undefined;
	}

	set(key: string, val: StoredCcHeadlessSession): void {
		this.map[key] = val;
		this.persist();
	}

	delete(key: string): void {
		if (!(key in this.map)) return;
		delete this.map[key];
		this.persist();
	}

	private persist(): void {
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			writeFileSync(this.path, JSON.stringify(this.map, null, 2), 'utf-8');
		} catch {
			/* best-effort: keep the in-memory map even if the disk write fails */
		}
	}
}
