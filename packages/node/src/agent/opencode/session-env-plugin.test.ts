import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionEnvPlugin } from './session-env-plugin.js';
import { OPENCODE_RUNBIND_DIR_ENV, writeRunBindFile } from './run-bind.js';

/**
 * REQ-010 S1: the plugin's ONLY job is to copy the opencode session id into the shell env so
 * `aichat send-message` can resolve its bound (aiclaw, room). Drive the real `shell.env` hook.
 */
describe('SessionEnvPlugin', () => {
	let dir = '';
	let savedEnv: string | undefined;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'oc-plugbind-'));
		savedEnv = process.env[OPENCODE_RUNBIND_DIR_ENV];
		process.env[OPENCODE_RUNBIND_DIR_ENV] = dir;
	});
	afterEach(() => {
		if (savedEnv === undefined) delete process.env[OPENCODE_RUNBIND_DIR_ENV];
		else process.env[OPENCODE_RUNBIND_DIR_ENV] = savedEnv;
		rmSync(dir, { recursive: true, force: true });
	});
	async function runHook(input: { cwd: string; sessionID?: string; callID?: string }) {
		// Plugin is invoked by opencode with (PluginInput, options?); we never use either here.
		const hooks = await SessionEnvPlugin({} as never, undefined);
		const hook = hooks['shell.env'];
		if (!hook) throw new Error('shell.env hook not registered');
		const output = { env: {} as Record<string, string> };
		await hook(input, output);
		return output;
	}

	it('injects OPENCODE_SESSION_ID when sessionID is present', async () => {
		const output = await runHook({ cwd: '/work', sessionID: 'ses_x' });
		expect(output.env.OPENCODE_SESSION_ID).toBe('ses_x');
		expect(output.env).toMatchObject({ CODEX_THREAD_ID: '', OPENCLAW_BIND: '', AICHAT_BIND: '', AICHAT_CONTEXT_KEY: '' });
		// No published binding → fail-closed empty, never an inherited run value.
		expect(output.env.AICHAT_RUN_BIND).toBe('');
	});

	it('injects the frozen run binding for a published session, overwriting inheritance', async () => {
		const token = 'a'.repeat(64);
		await writeRunBindFile(dir, 'ses_bound', { token, runId: 'run-A', conversationId: 'c1', generation: 1, createdAt: Date.now() });
		const hooks = await SessionEnvPlugin({} as never, undefined);
		const hook = hooks['shell.env'];
		if (!hook) throw new Error('shell.env hook not registered');
		const output = { env: { AICHAT_RUN_BIND: '0'.repeat(64) } as Record<string, string> };
		await hook({ cwd: '/work', sessionID: 'ses_bound', callID: 'call_1' }, output);
		expect(output.env.AICHAT_RUN_BIND).toBe(token);
		expect(output.env.OPENCODE_SESSION_ID).toBe('ses_bound');
	});

	it('treats malformed bindings and traversal ids as absent', async () => {
		writeFileSync(join(dir, 'ses_bad.json'), JSON.stringify({ token: 'short' }));
		expect((await runHook({ cwd: '/work', sessionID: 'ses_bad' })).env.AICHAT_RUN_BIND).toBe('');
		expect((await runHook({ cwd: '/work', sessionID: '../../x' })).env.AICHAT_RUN_BIND).toBe('');
	});

	it('suppresses inherited credentials when sessionID is absent', async () => {
		const output = await runHook({ cwd: '/work' });
		expect(output.env).toMatchObject({ OPENCODE_SESSION_ID: '', CODEX_THREAD_ID: '', OPENCLAW_BIND: '', AICHAT_BIND: '', AICHAT_CONTEXT_KEY: '' });
	});

	it('overrides conflicting inherited binding only for this shell invocation', async () => {
		const hooks = await SessionEnvPlugin({} as never, undefined);
		const hook = hooks['shell.env'];
		if (!hook) throw new Error('shell.env hook not registered');
		const output = { env: { EXISTING: '1', OPENCODE_SESSION_ID: 'old', AICHAT_CONTEXT_KEY: 'foreign' } as Record<string, string> };
		const prior = process.env.OPENCODE_SESSION_ID;
		await hook({ cwd: '/work', sessionID: 'ses_y' }, output);
		expect(output.env).toMatchObject({ EXISTING: '1', OPENCODE_SESSION_ID: 'ses_y', AICHAT_CONTEXT_KEY: '' });
		expect(process.env.OPENCODE_SESSION_ID).toBe(prior);
	});
});
