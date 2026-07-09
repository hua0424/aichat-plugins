import { join } from 'node:path';
import { AICHAT_HOME } from '../../config.js';
import { FileJsonMapStore } from '../file-map-store.js';

/** A persisted codex session binding: which codex threadId is bound to a (uid, room) key. */
export interface StoredCodexSession {
	threadId: string;
}

/**
 * REQ-010 S5 — injectable persisted map `key -> {threadId}` for cross-restart codex thread reuse.
 * Tests use an in-memory fake; production uses the file-backed impl below.
 *
 * Parallel to opencode's SessionStore but keyed on codex's `threadId` (codex natively injects
 * `CODEX_THREAD_ID` into its exec shell, so resolveSession reverse-looks-up by threadId).
 */
export interface CodexSessionStore {
	get(key: string): StoredCodexSession | undefined;
	set(key: string, val: StoredCodexSession): void;
	/** Drop a binding (parity with opencode; codex has no lazy-rebuild path yet, kept for symmetry). */
	delete(key: string): void;
	/**
	 * Reverse lookup — the key whose stored binding has this threadId, or undefined.
	 * Used by CodexDriver.resolveSession to map a codex thread id (carried by the loopback capability
	 * as `CODEX_THREAD_ID`) back to the `aiclaw-{uid}-room-{roomId}` key it was created under.
	 */
	findKeyByThreadId(threadId: string): string | undefined;
}

/** Default location: persists under ~/.aichat/ (a persistent volume) so reuse survives restarts. */
export const DEFAULT_CODEX_SESSIONS_PATH = join(AICHAT_HOME, 'codex', 'sessions.json');

/**
 * File-backed CodexSessionStore (a tiny JSON object map). Loads once on construction; each set()
 * writes the whole map back (the map is small — one entry per (aiclawUid, roomId) pair).
 * Read/parse/write failures degrade to an empty/no-op store rather than crashing the node.
 */
export class FileCodexSessionStore implements CodexSessionStore {
	private readonly store: FileJsonMapStore<StoredCodexSession>;

	constructor(path: string = DEFAULT_CODEX_SESSIONS_PATH) {
		this.store = new FileJsonMapStore(path, (v) => typeof v.threadId === 'string');
	}

	get(key: string): StoredCodexSession | undefined {
		return this.store.get(key);
	}

	set(key: string, val: StoredCodexSession): void {
		this.store.set(key, val);
	}

	delete(key: string): void {
		this.store.delete(key);
	}

	findKeyByThreadId(threadId: string): string | undefined {
		return this.store.findKey((v) => v.threadId === threadId);
	}

	/** aichatoverview#166: await the async persist chain (tests / graceful shutdown). */
	whenPersisted(): Promise<void> {
		return this.store.whenPersisted();
	}
}
