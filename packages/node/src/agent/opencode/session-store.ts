import { join } from 'node:path';
import { AICHAT_HOME } from '../../config.js';
import { FileJsonMapStore } from '../file-map-store.js';

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
 * File-backed SessionStore — the shared {@link FileJsonMapStore} keyed on `StoredSession`, validating
 * both `sessionID` + `directory` are strings. Reverse lookup (findKeyBySessionID) is a `findKey` predicate.
 */
export class FileSessionStore implements SessionStore {
	private readonly store: FileJsonMapStore<StoredSession>;

	constructor(path: string = DEFAULT_SESSIONS_PATH) {
		this.store = new FileJsonMapStore(
			path,
			(v) => typeof v.sessionID === 'string' && typeof v.directory === 'string',
		);
	}

	get(key: string): StoredSession | undefined {
		return this.store.get(key);
	}

	set(key: string, val: StoredSession): void {
		this.store.set(key, val);
	}

	delete(key: string): void {
		this.store.delete(key);
	}

	findKeyBySessionID(sessionID: string): string | undefined {
		return this.store.findKey((v) => v.sessionID === sessionID);
	}

	/** aichatoverview#166: await the async persist chain (tests / graceful shutdown). */
	whenPersisted(): Promise<void> {
		return this.store.whenPersisted();
	}
}
