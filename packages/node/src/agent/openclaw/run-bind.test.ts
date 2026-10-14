import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	defaultOpenclawRunBindDir, digestId, readOpenclawRunBindFile, removeOpenclawRunBindFile,
	resolveOpenclawRunBindDir, validOpenclawRunId, writeOpenclawRunBindFile,
	type OpenclawRunBindPayload,
} from './run-bind.js';

const token = 'c'.repeat(64);
function payload(over: Partial<OpenclawRunBindPayload> = {}): OpenclawRunBindPayload {
	return { token, runId: 'core-run-1', conversationId: 'conv-1', generation: 1, createdAt: 1700000000000, ...over };
}
function tmpDir() {
	const dir = mkdtempSync(join(tmpdir(), 'openclaw-runbind-'));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('openclaw run-bind file bridge (#406)', () => {
	it('round-trips the frozen binding for the accepted native runId', async () => {
		const t = tmpDir();
		try {
			await writeOpenclawRunBindFile(t.dir, 'gateway-run-1', payload());
			expect(await readOpenclawRunBindFile(t.dir, 'gateway-run-1')).toEqual(payload());
		} finally { t.cleanup(); }
	});

	it('refuses invalid native run ids (no path traversal)', async () => {
		expect(validOpenclawRunId('../evil')).toBe(false);
		expect(validOpenclawRunId('.hidden')).toBe(false);
		expect(validOpenclawRunId('a/b')).toBe(false);
		expect(validOpenclawRunId('')).toBe(false);
		expect(validOpenclawRunId('gateway-run-1')).toBe(true);
		const t = tmpDir();
		try {
			await expect(writeOpenclawRunBindFile(t.dir, '../evil', payload())).rejects.toThrow();
			expect(await readOpenclawRunBindFile(t.dir, '../evil')).toBeUndefined();
		} finally { t.cleanup(); }
	});

	it('refuses malformed payloads and reads them as absent', async () => {
		const t = tmpDir();
		try {
			await expect(writeOpenclawRunBindFile(t.dir, 'r1', payload({ token: 'forged' }))).rejects.toThrow();
			await writeOpenclawRunBindFile(t.dir, 'r1', payload());
			expect(await readOpenclawRunBindFile(t.dir, 'no-such-run')).toBeUndefined();
		} finally { t.cleanup(); }
	});

	it('guarded removal keeps run B’s overwrite when run A withdraws', async () => {
		const t = tmpDir();
		try {
			await writeOpenclawRunBindFile(t.dir, 'gw-run', payload({ runId: 'core-A' }));
			await writeOpenclawRunBindFile(t.dir, 'gw-run', payload({ runId: 'core-B' }));
			expect(await removeOpenclawRunBindFile(t.dir, 'gw-run', 'core-A')).toBe(false);
			expect(await readOpenclawRunBindFile(t.dir, 'gw-run')).toMatchObject({ runId: 'core-B' });
			expect(await removeOpenclawRunBindFile(t.dir, 'gw-run', 'core-B')).toBe(true);
			expect(await readOpenclawRunBindFile(t.dir, 'gw-run')).toBeUndefined();
		} finally { t.cleanup(); }
	});

	it('surfaces write failures instead of submitting unprovable work', async () => {
		// A regular file as the "dir" fails mkdir on every platform (Windows + POSIX).
		const t = tmpDir();
		try {
			const blocker = join(t.dir, 'blocker');
			writeFileSync(blocker, 'x');
			await expect(writeOpenclawRunBindFile(join(blocker, 'sub'), 'r1', payload())).rejects.toThrow();
		} finally { t.cleanup(); }
	});

	it('digests ids without leaking them', () => {
		expect(digestId('gateway-run-1')).toMatch(/^[0-9a-f]{12}$/);
		expect(digestId('gateway-run-1')).not.toContain('gateway-run-1');
	});

	it('resolves the dir from env override or AICHAT_HOME layout', () => {
		const prevEnv = process.env.AICHAT_OPENCLAW_RUNBIND_DIR, prevHome = process.env.AICHAT_HOME;
		try {
			process.env.AICHAT_OPENCLAW_RUNBIND_DIR = '/tmp/custom-406';
			expect(resolveOpenclawRunBindDir()).toBe(resolve('/tmp/custom-406'));
			delete process.env.AICHAT_OPENCLAW_RUNBIND_DIR;
			process.env.AICHAT_HOME = '/home/test406';
			expect(defaultOpenclawRunBindDir()).toBe(join(resolve('/home/test406'), 'openclaw', 'run-bind'));
		} finally {
			if (prevEnv === undefined) delete process.env.AICHAT_OPENCLAW_RUNBIND_DIR; else process.env.AICHAT_OPENCLAW_RUNBIND_DIR = prevEnv;
			if (prevHome === undefined) delete process.env.AICHAT_HOME; else process.env.AICHAT_HOME = prevHome;
		}
	});
});
