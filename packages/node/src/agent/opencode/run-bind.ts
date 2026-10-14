import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * #405 — per-session reply-binding file bridging the node driver (writer) and the
 * `opencode serve`-side `shell.env` hook (reader).
 *
 * Why a file: the hook runs inside the spawned `opencode serve` process, which the
 * driver reaches only through the SDK (no env channel for the bash tool). The driver
 * publishes the frozen #404 `replyToken` for its session BEFORE submitting the prompt;
 * the hook resolves `sessionID → token` with zero knowledge of "the current run", so
 * a late shell can only ever carry the token its own session file names — never a
 * guessed current/latest run. A spawned shell freezes its env at spawn, so run B
 * overwriting the file cannot change a late run-A send (still bound to A while the
 * core binding lives); a shell spawned with no file gets an EMPTY value (fail-closed
 * legacy-unknown, inheritance stripped — never another run's token).
 *
 * Fail-closed everywhere: unreadable/malformed/foreign files read as absent; unlink
 * only removes a file this run published (runId-guarded).
 */

/** Env override for the run-bind dir (read by the serve-side hook); falls back to AICHAT_HOME layout. */
export const OPENCODE_RUNBIND_DIR_ENV = 'AICHAT_OPENCODE_RUNBIND_DIR';

/** Frozen #404 reply tokens are 32 random bytes hex-encoded (see ConversationStore.beginRun). */
const TOKEN_RE = /^[0-9a-f]{64}$/;
/** Native session ids address files; anything else is refused (no path traversal). */
const SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/;

export interface RunBindPayload {
	token: string;
	runId: string;
	conversationId: string;
	generation: number;
	createdAt: number;
}

export function defaultRunBindDir(home?: string): string {
	const base = home ?? process.env.AICHAT_HOME ?? join(homedir(), '.aichat');
	return join(resolve(base), 'opencode', 'run-bind');
}

export function resolveRunBindDir(): string {
	const override = process.env[OPENCODE_RUNBIND_DIR_ENV];
	return override ? resolve(override) : defaultRunBindDir();
}

function fileFor(dir: string, sessionID: string): string | undefined {
	if (!SESSION_RE.test(sessionID)) return undefined;
	return join(resolve(dir), `${sessionID}.json`);
}

function validPayload(value: unknown): value is RunBindPayload {
	if (!value || typeof value !== 'object') return false;
	const v = value as Record<string, unknown>;
	return typeof v.token === 'string' && TOKEN_RE.test(v.token) &&
		typeof v.runId === 'string' && v.runId.length > 0 && v.runId.length <= 256 &&
		typeof v.conversationId === 'string' && v.conversationId.length > 0 &&
		Number.isSafeInteger(v.generation) && (v.generation as number) >= 1 &&
		Number.isSafeInteger(v.createdAt);
}

/** Publish (or replace) this session's binding before prompt submission. Throws on I/O failure. */
export async function writeRunBindFile(dir: string, sessionID: string, payload: RunBindPayload): Promise<void> {
	const file = fileFor(dir, sessionID);
	if (!file) throw new Error('refusing to publish run binding for an invalid session id');
	if (!validPayload(payload)) throw new Error('refusing to publish an invalid run binding payload');
	await mkdir(resolve(dir), { recursive: true });
	// Atomic publish like the core snapshot store: 0600 temp + rename, never a partial read.
	const tmp = join(resolve(dir), `.${sessionID}.${randomBytes(8).toString('hex')}.tmp`);
	await writeFile(tmp, JSON.stringify(payload), { mode: 0o600 });
	await rename(tmp, file);
}

/** Read this session's binding; absent/unreadable/malformed/foreign → undefined (fail-closed). */
export async function readRunBindFile(dir: string, sessionID: string): Promise<RunBindPayload | undefined> {
	const file = fileFor(dir, sessionID);
	if (!file) return undefined;
	try {
		const raw = await readFile(file, 'utf8');
		const value: unknown = JSON.parse(raw);
		return validPayload(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Remove the session file published by THIS run only: when `runId` is given and the
 * file names another run (B already overwrote it), the file is kept. Best-effort —
 * a stale file only ever carries a core-verified-or-rejected token, never a guess.
 */
export async function removeRunBindFile(dir: string, sessionID: string, runId?: string): Promise<boolean> {
	const file = fileFor(dir, sessionID);
	if (!file) return false;
	try {
		if (runId !== undefined) {
			const current = await readRunBindFile(dir, sessionID);
			if (current && current.runId !== runId) return false;
		}
		await unlink(file);
		return true;
	} catch {
		return false;
	}
}

/** Desensitized short digest for reports: raw native ids/tokens never enter logs or issues. */
export function digestId(value: string): string {
	return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
}
