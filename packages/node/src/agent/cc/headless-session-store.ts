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
 * Parallel to codex's CodexSessionStore, keyed on claude's `session_id` (captured from the headless
 * stdout `system/init` event). NOTE: unlike codex there is NO reverse lookup — resolveSession parses
 * the AICHAT_BIND binding (parseCcBinding) directly, so the store is only consulted to reuse a
 * `session_id` for `--resume` on the next turn of the same (aiclawUid, roomId).
 * Key = `aiclaw-{uid}-room-{roomId}`.
 */
export interface CcHeadlessSessionStore {
	get(key: string): StoredCcHeadlessSession | undefined;
	set(key: string, val: StoredCcHeadlessSession): void;
	/** Drop a binding (parity with codex; kept for symmetry / future self-heal). */
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
