import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import {
	OPENCODE_RUNBIND_DIR_ENV,
	defaultRunBindDir,
	digestId,
	readRunBindFile,
	removeRunBindFile,
	resolveRunBindDir,
	writeRunBindFile,
	type RunBindPayload,
} from './run-bind.js';

const TOKEN = 'f'.repeat(64);
function payload(over: Partial<RunBindPayload> = {}): RunBindPayload {
	return { token: TOKEN, runId: 'run-A', conversationId: 'conv-1', generation: 3, createdAt: Date.now(), ...over };
}

describe('opencode run-bind file', () => {
	let dir = '';
	let savedEnv: string | undefined;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'oc-runbind-'));
		savedEnv = process.env[OPENCODE_RUNBIND_DIR_ENV];
	});
	afterEach(() => {
		if (savedEnv === undefined) delete process.env[OPENCODE_RUNBIND_DIR_ENV];
		else process.env[OPENCODE_RUNBIND_DIR_ENV] = savedEnv;
		rmSync(dir, { recursive: true, force: true });
	});

	it('round-trips a published binding', async () => {
		const p = payload();
		await writeRunBindFile(dir, 'ses_abc', p);
		expect(await readRunBindFile(dir, 'ses_abc')).toEqual(p);
	});

	it('a later run overwrites the same session file', async () => {
		await writeRunBindFile(dir, 'ses_abc', payload({ runId: 'run-A' }));
		await writeRunBindFile(dir, 'ses_abc', payload({ runId: 'run-B' }));
		expect((await readRunBindFile(dir, 'ses_abc'))?.runId).toBe('run-B');
	});

	it('refuses path-traversal session ids on write and reads them as absent', async () => {
		await expect(writeRunBindFile(dir, '../../evil', payload())).rejects.toThrow(/invalid session id/);
		expect(await readRunBindFile(dir, '../../evil')).toBeUndefined();
		expect(await readRunBindFile(dir, '')).toBeUndefined();
	});

	it('refuses a malformed token payload on write', async () => {
		await expect(writeRunBindFile(dir, 'ses_x', payload({ token: 'not-a-token' }))).rejects.toThrow(/invalid run binding payload/);
		expect(await readRunBindFile(dir, 'ses_x')).toBeUndefined();
	});

	it('reads missing/malformed/foreign files as absent (fail-closed)', async () => {
		expect(await readRunBindFile(dir, 'ses_missing')).toBeUndefined();
		writeFileSync(join(dir, 'ses_bad.json'), '{not json');
		expect(await readRunBindFile(dir, 'ses_bad')).toBeUndefined();
		writeFileSync(join(dir, 'ses_foreign.json'), JSON.stringify({ token: TOKEN }));
		expect(await readRunBindFile(dir, 'ses_foreign')).toBeUndefined();
		writeFileSync(join(dir, 'ses_short.json'), JSON.stringify(payload({ token: 'abc' })));
		expect(await readRunBindFile(dir, 'ses_short')).toBeUndefined();
	});

	it('guarded removal keeps a file another run already overwrote', async () => {
		await writeRunBindFile(dir, 'ses_abc', payload({ runId: 'run-A' }));
		await writeRunBindFile(dir, 'ses_abc', payload({ runId: 'run-B' }));
		expect(await removeRunBindFile(dir, 'ses_abc', 'run-A')).toBe(false);
		expect((await readRunBindFile(dir, 'ses_abc'))?.runId).toBe('run-B');
		expect(await removeRunBindFile(dir, 'ses_abc', 'run-B')).toBe(true);
		expect(await readRunBindFile(dir, 'ses_abc')).toBeUndefined();
	});

	it('unconditional removal is best-effort on absent files', async () => {
		expect(await removeRunBindFile(dir, 'ses_gone')).toBe(false);
	});

	it('write failure surfaces (caller must fail the run, never send legacy silently)', async () => {
		const file = join(dir, 'blocker');
		writeFileSync(file, 'x');
		await expect(writeRunBindFile(join(file, 'sub'), 'ses_x', payload())).rejects.toThrow();
	});

	it('digestId is stable, short and non-reversible in reports', () => {
		expect(digestId('ses_abc')).toBe(digestId('ses_abc'));
		expect(digestId('ses_abc')).toHaveLength(12);
		expect(digestId('ses_abc')).not.toContain('ses_abc');
	});

	it('resolveRunBindDir prefers the env override, else the AICHAT_HOME layout', () => {
		process.env[OPENCODE_RUNBIND_DIR_ENV] = dir;
		expect(resolveRunBindDir()).toBe(dir);
		delete process.env[OPENCODE_RUNBIND_DIR_ENV];
		expect(defaultRunBindDir('/home/test')).toBe(join(resolve('/home/test'), 'opencode', 'run-bind'));
	});
});
