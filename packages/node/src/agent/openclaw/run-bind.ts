import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * #406 — per-gateway-run reply-binding file bridging the node driver (writer) and the
 * gateway-side `before_tool_call` hook (reader, in `aichat-claw`).
 *
 * Why a file: the hook runs inside the gateway process, which the driver reaches only
 * through the WS-RPC `agent` request (no env channel for the exec tool). The driver
 * publishes this run's frozen #404 `replyToken` keyed by the ACCEPTED native runId as
 * soon as the gateway confirms it; the hook resolves `native runId → token` with zero
 * knowledge of "the current run", so a late exec from run A can only ever carry the
 * token A's own accepted runId names — never a guessed current/latest run. An exec
 * spawned with no file for its runId gets an EMPTY value (fail-closed, inheritance and
 * model-forged values stripped — never another run's token).
 *
 * The gateway assigns the native runId, so — unlike #405 (session known pre-prompt) —
 * publish happens AT accepted, not before submit. A hook firing before the accepted
 * frame only gets a bounded wait for the exact file (see `aichat-claw`); no guessing.
 * Withdrawal is guarded by the core runId so run B's overwrite is never removed.
 *
 * Fail-closed everywhere: unreadable/malformed/foreign files read as absent.
 */

export const OPENCLAW_RUNBIND_DIR_ENV = 'AICHAT_OPENCLAW_RUNBIND_DIR';

/** Frozen #404 reply tokens are 32 random bytes hex-encoded (see ConversationStore.beginRun). */
const TOKEN_RE = /^[0-9a-f]{64}$/;
/**
 * Native run ids address files; anything else is refused (no path traversal).
 * Gateway runIds are opaque strings — allow dot as well as word chars and dash, but
 * never a leading dot or any `..` (so `a/../b` and absolute paths cannot escape).
 */
const RUNID_RE = /^[A-Za-z0-9_.-]{1,128}$/;

export interface OpenclawRunBindPayload {
	token: string;
	/** Core runId that owns this binding (withdrawal guard + conflict signal). */
	runId: string;
	conversationId: string;
	generation: number;
	createdAt: number;
}

export function defaultOpenclawRunBindDir(home?: string): string {
	const base = home ?? process.env.AICHAT_HOME ?? join(homedir(), '.aichat');
	return join(resolve(base), 'openclaw', 'run-bind');
}

export function resolveOpenclawRunBindDir(): string {
	const override = process.env[OPENCLAW_RUNBIND_DIR_ENV];
	return override ? resolve(override) : defaultOpenclawRunBindDir();
}

export function validOpenclawRunId(runId: string): boolean {
	return typeof runId === 'string' && RUNID_RE.test(runId) &&
		!runId.startsWith('.') && !runId.includes('..');
}

function fileFor(dir: string, runId: string): string | undefined {
	if (!validOpenclawRunId(runId)) return undefined;
	return join(resolve(dir), `${runId}.json`);
}

function validPayload(value: unknown): value is OpenclawRunBindPayload {
	if (!value || typeof value !== 'object') return false;
	const v = value as Record<string, unknown>;
	return typeof v.token === 'string' && TOKEN_RE.test(v.token) &&
		typeof v.runId === 'string' && v.runId.length > 0 && v.runId.length <= 256 &&
		typeof v.conversationId === 'string' && v.conversationId.length > 0 &&
		Number.isSafeInteger(v.generation) && (v.generation as number) >= 1 &&
		Number.isSafeInteger(v.createdAt);
}

/** Publish (or replace) this accepted native run's binding. Throws on I/O failure. */
export async function writeOpenclawRunBindFile(dir: string, runId: string, payload: OpenclawRunBindPayload): Promise<void> {
	const file = fileFor(dir, runId);
	if (!file) throw new Error('refusing to publish run binding for an invalid native run id');
	if (!validPayload(payload)) throw new Error('refusing to publish an invalid run binding payload');
	await mkdir(resolve(dir), { recursive: true });
	// Atomic publish like the core snapshot store: 0600 temp + rename, never a partial read.
	// Both writer (node) and reader (gateway) run as the same uid, so 0600 stays readable.
	const tmp = join(resolve(dir), `.${Date.now()}.${randomBytes(8).toString('hex')}.tmp`);
	await writeFile(tmp, JSON.stringify(payload), { mode: 0o600 });
	await rename(tmp, file);
}

/** Read this native run's binding; absent/unreadable/malformed/foreign → undefined (fail-closed). */
export async function readOpenclawRunBindFile(dir: string, runId: string): Promise<OpenclawRunBindPayload | undefined> {
	const file = fileFor(dir, runId);
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
 * Remove the native-run file published by THIS core run only: when `runId` (core) is
 * given and the file names another core run (B already overwrote it), the file is kept.
 * Best-effort — a stale file only ever carries a core-verified-or-rejected token, never a guess.
 */
export async function removeOpenclawRunBindFile(dir: string, runId: string, coreRunId?: string): Promise<boolean> {
	const file = fileFor(dir, runId);
	if (!file) return false;
	try {
		if (coreRunId !== undefined) {
			const current = await readOpenclawRunBindFile(dir, runId);
			if (current && current.runId !== coreRunId) return false;
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
