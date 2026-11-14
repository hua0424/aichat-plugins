import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { chmod, readFile, rm, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, delimiter } from 'node:path';
import { CodexTurnGrants, GRANT_BOOTSTRAP, codexHookConfig } from './turn-grants.js';

const grants: CodexTurnGrants[] = [];
afterEach(async () => { for (const grant of grants.splice(0)) await rm(grant.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
async function create() { const grant = await CodexTurnGrants.create(); grants.push(grant); return grant; }
function hook(grant: CodexTurnGrants, session = 'thread-1', turn = 'turn-1', command = 'echo harmless') {
	const child = spawn(process.execPath, ['-e', GRANT_BOOTSTRAP, grant.helper, grant.helperHash], { stdio: 'pipe' });
	let stdout = '', stderr = '';
	child.stdout.on('data', (part) => { stdout += part; });
	child.stderr.on('data', (part) => { stderr += part; });
	child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: session, turn_id: turn, tool_name: 'Bash', tool_input: { command } }));
	return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
		child.on('error', reject);
		child.on('close', (code) => resolve({ code, stdout, stderr }));
	});
}

async function executeShell(command: string, marker: string) {
	const shell = process.env.AICHAT_TEST_SH ?? (process.platform === 'win32'
		? process.env.PATH?.split(delimiter).map((directory) => join(directory, '..', 'bin', 'sh.exe')).find(existsSync) : '/bin/sh');
	if (!shell) throw new Error('Local POSIX shell required for source gate check; set AICHAT_TEST_SH');
	const child = spawn(shell, ['-c', command], { stdio: 'ignore', env: { ...process.env, MARKER: marker.replaceAll('\\', '/') } });
	return new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
}

describe('Codex exact native turn grants', () => {
	it('waits for the exact native thread/turn grant and exposes a path, never a token in argv/output', async () => {
		const grant = await create();
		const result = hook(grant);
		await grant.grant({ sessionId: 'other-thread', turnId: 'turn-1' }, 'other-secret');
		await grant.grant({ sessionId: 'thread-1', turnId: 'turn-1' }, 'frozen-secret');
		const response = await result;
		expect(response.code).toBe(0);
		const output = JSON.parse(response.stdout);
		expect(output.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'allow' });
		const command = output.hookSpecificOutput.updatedInput.command as string;
		expect(command).toContain(' && eval ');
		expect(command).not.toContain('frozen-secret');
		expect(command).not.toContain('other-secret');
		expect(grant.command()).not.toContain('frozen-secret');
		const id = createHash('sha256').update(JSON.stringify(['thread-1', 'turn-1'])).digest('hex');
		expect(await readFile(join(grant.directory, `${id}.env`), 'utf8')).toBe("export AICHAT_RUN_BIND='frozen-secret'\n");
	});
	it('never rewrites a frozen token to a later turn/request token', async () => {
		const grant = await create();
		const ref = { sessionId: 'thread-1', turnId: 'turn-1' };
		await grant.grant(ref, 'first');
		await grant.grant(ref, 'first');
		await expect(grant.grant(ref, 'second')).rejects.toThrow('CODEX_TURN_GRANT_CONFLICT');
		const id = createHash('sha256').update(JSON.stringify(['thread-1', 'turn-1'])).digest('hex');
		expect(await readFile(join(grant.directory, `${id}.env`), 'utf8')).toContain("'first'");
	});
	it('rejects an old/revoked native unit instead of attaching it to a new generation', async () => {
		const grant = await create();
		await grant.grant({ sessionId: 'thread-1', turnId: 'turn-2' }, 'new');
		await grant.revoke({ sessionId: 'thread-1', turnId: 'turn-1' });
		const response = await hook(grant);
		expect(response.code).toBe(2);
		expect(response.stdout).toBe('');
		expect(response.stderr).toBe('CODEX_TURN_GRANT_UNAVAILABLE\n');
	});
	it('pins helper bytes independently of native hook command trust', async () => {
		const grant = await create();
		await chmod(grant.helper, 0o600);
		await writeFile(grant.helper, "process.stdout.write('should-not-run')");
		const response = await hook(grant);
		expect(response.code).toBe(2);
		expect(response.stdout).toBe('');
		expect(response.stderr).toBe('CODEX_HOOK_INTEGRITY_FAILED\n');
	});
	it('executes all original semicolon/multiline text only after successful source; missing source executes none', async () => {
		const grant = await create(), ref = { sessionId: 'thread-1', turnId: 'turn-1' };
		await grant.grant(ref, 'frozen-secret');
		const marker = join(grant.directory, 'executed.txt');
		const original = `printf '%s' "$AICHAT_RUN_BIND" > "$MARKER"; printf '|second' >> "$MARKER"\nprintf '|third' >> "$MARKER"`;
		const response = await hook(grant, 'thread-1', 'turn-1', original);
		const command = JSON.parse(response.stdout).hookSpecificOutput.updatedInput.command as string;
		expect(await executeShell(command, marker)).toBe(0);
		expect(await readFile(marker, 'utf8')).toBe('frozen-secret|second|third');
		await unlink(marker);
		const id = createHash('sha256').update(JSON.stringify(['thread-1', 'turn-1'])).digest('hex');
		await unlink(join(grant.directory, `${id}.env`));
		expect(await executeShell(command, marker)).not.toBe(0);
		expect(existsSync(marker)).toBe(false);
	});
	it('a late already-rewritten native command cannot execute after the exact turn is revoked', async () => {
		const grant = await create(), ref = { sessionId: 'thread-1', turnId: 'turn-1' };
		await grant.grant(ref, 'old');
		const marker = join(grant.directory, 'late.txt');
		const response = await hook(grant, 'thread-1', 'turn-1', `printf 'ran' > "$MARKER"; printf 'second' >> "$MARKER"`);
		const command = JSON.parse(response.stdout).hookSpecificOutput.updatedInput.command as string;
		await grant.revoke(ref);
		await grant.revoke(ref); // immutable tombstone is idempotent on POSIX too
		expect(await executeShell(command, marker)).not.toBe(0);
		expect(existsSync(marker)).toBe(false);
	});
	it('closing a native lifetime rejects new grants and fences already-rewritten commands', async () => {
		const grant = await create(), ref = { sessionId: 'thread-1', turnId: 'turn-1' };
		await grant.grant(ref, 'old');
		const marker = join(grant.directory, 'closed.txt');
		const response = await hook(grant, 'thread-1', 'turn-1', `printf 'ran' > "$MARKER"`);
		await grant.revokeAll();
		await grant.revokeAll();
		await expect(grant.grant({ sessionId: 'thread-1', turnId: 'turn-2' }, 'next')).rejects.toThrow('CODEX_TURN_GRANTS_CLOSED');
		expect(await executeShell(JSON.parse(response.stdout).hookSpecificOutput.updatedInput.command, marker)).not.toBe(0);
		expect(existsSync(marker)).toBe(false);
	});
	it('uses only session-flag trust for the own fixed hook; does not trust global/workspace hooks', () => {
		expect(codexHookConfig('own-command')).toEqual({ hooks: {
			PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'own-command', timeout: 15, async: false }] }],
			state: { '/<session-flags>/config.toml:pre_tool_use:0:0': {
				enabled: true,
				trusted_hash: 'sha256:' + createHash('sha256').update('{"event_name":"pre_tool_use","hooks":[{"async":false,"command":"own-command","timeout":15,"type":"command"}],"matcher":"Bash"}').digest('hex'),
			} },
		} });
	});
});
