import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { AICHAT_HOME } from '../../config.js';

/** A persisted opencode session binding: which opencode sessionID lives in which directory. */
export interface StoredSession {
	sessionID: string;
	directory: string;
}

/**
 * Injectable persisted map `key -> {sessionID, directory}` for cross-restart session reuse.
 * Tests use an in-memory fake; production uses the file-backed impl below.
 */
export interface SessionStore {
	get(key: string): StoredSession | undefined;
	set(key: string, val: StoredSession): void;
	/** REQ-008 #78 P2③: drop a stale binding so the next openSession recreates it lazily. */
	delete(key: string): void;
	/**
	 * REQ-010 S1: reverse lookup — the key whose stored binding has this sessionID, or undefined.
	 * Used by OpencodeDriver.resolveSession to map an opencode session id (which the loopback
	 * capability carries) back to the `aiclaw-{uid}-room-{roomId}` key it was created under.
	 */
	findKeyBySessionID(sessionID: string): string | undefined;
}

/** Default location: persists under ~/.aichat/ (a persistent volume) so reuse survives restarts. */
export const DEFAULT_SESSIONS_PATH = join(AICHAT_HOME, 'opencode', 'sessions.json');

/**
 * File-backed SessionStore (a tiny JSON object map). Loads once on construction; each set()
 * writes the whole map back (the map is small — one entry per (aiclawUid, roomId) pair).
 * Read/parse/write failures degrade to an empty/no-op store rather than crashing the node.
 */
export class FileSessionStore implements SessionStore {
	private map: Record<string, StoredSession> = {};

	constructor(private readonly path: string = DEFAULT_SESSIONS_PATH) {
		this.load();
	}

	private load(): void {
		if (!existsSync(this.path)) return;
		try {
			const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as unknown;
			if (parsed && typeof parsed === 'object') {
				this.map = parsed as Record<string, StoredSession>;
			}
		} catch {
			this.map = {};
		}
	}

	get(key: string): StoredSession | undefined {
		const v = this.map[key];
		if (v && typeof v.sessionID === 'string' && typeof v.directory === 'string') return v;
		return undefined;
	}

	set(key: string, val: StoredSession): void {
		this.map[key] = val;
		this.persist();
	}

	delete(key: string): void {
		if (!(key in this.map)) return;
		delete this.map[key];
		this.persist();
	}

	findKeyBySessionID(sessionID: string): string | undefined {
		for (const [key, val] of Object.entries(this.map)) {
			if (val?.sessionID === sessionID) return key;
		}
		return undefined;
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
