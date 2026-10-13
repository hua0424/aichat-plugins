import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * #406 — gateway-side reader for the per-native-run binding files the node driver
 * publishes (see `packages/node/src/agent/openclaw/run-bind.ts`).
 *
 * The driver writes `<dir>/<nativeRunId>.json` the moment the gateway's accepted frame
 * names the run; this module resolves `native runId → frozen reply token` with zero
 * knowledge of "the current run". Absent/unreadable/malformed/foreign → undefined
 * (fail-closed): the caller injects an EMPTY `AICHAT_RUN_BIND`, stripping inheritance
 * and model-forged values — never another run's token, never a guess.
 *
 * Write path lives ONLY in the node driver; this module never writes or deletes.
 * Both processes run as the same uid, so the driver's 0600 files stay readable here.
 */

export const OPENCLAW_RUNBIND_DIR_ENV = 'AICHAT_OPENCLAW_RUNBIND_DIR';

/** Frozen #404 reply tokens are 32 random bytes hex-encoded. */
const TOKEN_RE = /^[0-9a-f]{64}$/;
const RUNID_RE = /^[A-Za-z0-9_.-]{1,128}$/;

export interface OpenclawRunBindPayload {
	token: string;
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

export function validOpenclawRunId(runId: unknown): runId is string {
	return typeof runId === 'string' && RUNID_RE.test(runId) &&
		!runId.startsWith('.') && !runId.includes('..');
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

/** Read one native run's binding; anything untrusted → undefined (fail-closed). Never throws. */
export async function readOpenclawRunBind(dir: string, runId: string): Promise<OpenclawRunBindPayload | undefined> {
	try {
		if (!validOpenclawRunId(runId)) return undefined;
		const raw = await readFile(join(resolve(dir), `${runId}.json`), 'utf8');
		const value: unknown = JSON.parse(raw);
		return validPayload(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Bounded wait for the EXACT native run's file (covers a hook firing before the node's
 * accepted-frame publish). Polls only this runId — never falls back to another run,
 * "latest", or room/session current. Timeout → undefined (fail-closed). Never throws.
 *
 * ponytail: fixed small budget (default 2s/25ms). A present file returns on the first
 * read; an unmanaged exec (no file, ever) pays at most the timeout before failing
 * closed — latency ceiling, not a correctness shortcut. No upgrade path planned:
 * shrinking the budget would re-open the early-hook race the wait exists to cover.
 */
export async function waitForOpenclawRunBind(
	dir: string,
	runId: string,
	opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<OpenclawRunBindPayload | undefined> {
	const timeoutMs = opts?.timeoutMs ?? 2000;
	const intervalMs = opts?.intervalMs ?? 25;
	try {
		const first = await readOpenclawRunBind(dir, runId);
		if (first) return first;
		const deadline = Date.now() + Math.max(0, timeoutMs);
		for (;;) {
			const remain = deadline - Date.now();
			if (remain <= 0) return undefined;
			await sleep(Math.min(Math.max(1, intervalMs), remain));
			const found = await readOpenclawRunBind(dir, runId);
			if (found) return found;
		}
	} catch {
		return undefined;
	}
}
