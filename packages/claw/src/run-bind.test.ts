import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	readOpenclawRunBind, resolveOpenclawRunBindDir, validOpenclawRunId, waitForOpenclawRunBind,
} from './run-bind.js';

const token = 'e'.repeat(64);
function tmpDir() {
	const dir = mkdtempSync(join(tmpdir(), 'claw-runbind-'));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function write(dir: string, runId: string, value: unknown) {
	writeFileSync(join(dir, `${runId}.json`), JSON.stringify(value));
}

describe('gateway run-bind reader (#406)', () => {
	it('reads the exact native run file', async () => {
		const t = tmpDir();
		try {
			write(t.dir, 'gw-1', { token, runId: 'core-1', conversationId: 'c1', generation: 2, createdAt: 1 });
			expect(await readOpenclawRunBind(t.dir, 'gw-1')).toMatchObject({ token, runId: 'core-1' });
			expect(await readOpenclawRunBind(t.dir, 'gw-other')).toBeUndefined();
		} finally { t.cleanup(); }
	});

	it('fail-closed: forged/malformed/traversal → undefined, never throws', async () => {
		const t = tmpDir();
		try {
			write(t.dir, 'gw-forged', { token: 'not-a-token', runId: 'core-x', conversationId: 'c', generation: 1, createdAt: 1 });
			expect(await readOpenclawRunBind(t.dir, 'gw-forged')).toBeUndefined();
			expect(await readOpenclawRunBind(t.dir, '../evil')).toBeUndefined();
			expect(await readOpenclawRunBind(t.dir, '')).toBeUndefined();
			expect(validOpenclawRunId('gw-1')).toBe(true);
			expect(validOpenclawRunId('..')).toBe(false);
		} finally { t.cleanup(); }
	});

	it('bounded wait finds a file published just after the hook fired', async () => {
		const t = tmpDir();
		try {
			const pending = waitForOpenclawRunBind(t.dir, 'gw-early', { timeoutMs: 2000, intervalMs: 10 });
			await new Promise((r) => setTimeout(r, 50));
			write(t.dir, 'gw-early', { token, runId: 'core-e', conversationId: 'c', generation: 1, createdAt: 1 });
			expect(await pending).toMatchObject({ token, runId: 'core-e' });
		} finally { t.cleanup(); }
	});

	it('bounded wait times out instead of guessing another run', async () => {
		const t = tmpDir();
		try {
			write(t.dir, 'gw-other', { token, runId: 'core-o', conversationId: 'c', generation: 1, createdAt: 1 });
			const started = Date.now();
			expect(await waitForOpenclawRunBind(t.dir, 'gw-missing', { timeoutMs: 120, intervalMs: 10 })).toBeUndefined();
			expect(Date.now() - started).toBeLessThan(2000);
		} finally { t.cleanup(); }
	});

	it('resolves the dir from the override env', () => {
		const prev = process.env.AICHAT_OPENCLAW_RUNBIND_DIR;
		try {
			process.env.AICHAT_OPENCLAW_RUNBIND_DIR = '/tmp/claw-406';
			expect(resolveOpenclawRunBindDir()).toMatch(/claw-406$/);
		} finally {
			if (prev === undefined) delete process.env.AICHAT_OPENCLAW_RUNBIND_DIR;
			else process.env.AICHAT_OPENCLAW_RUNBIND_DIR = prev;
		}
	});
});
