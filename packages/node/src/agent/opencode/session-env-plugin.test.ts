import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionEnvPlugin } from './session-env-plugin.js';
import { OPENCODE_RUNBIND_DIR_ENV, writeRunBindFile } from './run-bind.js';
import { publishInput, readyInput } from './input-bind.js';

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

	it('loads frozen native user SYSTEM and routes shell by call parent rather than latest input', async () => {
		await publishInput(dir, { sessionID: 'ses_a', inputID: 'msg_a', conversationId: 'c', generation: 1, systemPrompt: 'persona A; reply CLI' });
		await publishInput(dir, { sessionID: 'ses_a', inputID: 'msg_b', conversationId: 'c', generation: 1, systemPrompt: 'persona B' });
		await readyInput(dir, 'ses_a', 'msg_a', { token: 'a'.repeat(64), runId: 'a', thinkingId: 'ta' });
		await readyInput(dir, 'ses_a', 'msg_b', { token: 'b'.repeat(64), runId: 'b', thinkingId: 'tb' });
		const hooks = await SessionEnvPlugin({} as never, { bindingTimeoutMs: 30 });
		const user = { message: { id: 'msg_a', sessionID: 'ses_a' }, parts: [] };
		await hooks['chat.message']!({ sessionID: 'ses_a', messageID: 'msg_a' }, user as never);
		expect(user.message).toMatchObject({ system: 'persona A; reply CLI' });
		await hooks.event!({ event: { type: 'message.updated', properties: { info: { sessionID: 'ses_a', role: 'assistant', id: 'as_a', parentID: 'msg_a' } } } } as never);
		await hooks.event!({ event: { type: 'message.part.updated', properties: { part: { sessionID: 'ses_a', type: 'tool', callID: 'call_a', messageID: 'as_a' } } } } as never);
		const output = { env: {} as Record<string, string> };
		await hooks['shell.env']!({ cwd: '/work', sessionID: 'ses_a', callID: 'call_a' }, output);
		expect(output.env.AICHAT_RUN_BIND).toBe('a'.repeat(64));
	});

	it('rejects managed shell timeout and conflicting parent evidence without falling back to session token', async () => {
		await publishInput(dir, { sessionID: 'ses_a', inputID: 'msg_a', conversationId: 'c', generation: 1, systemPrompt: 'A' });
		await writeRunBindFile(dir, 'ses_a', { token: 'f'.repeat(64), runId: 'latest', conversationId: 'c', generation: 1, createdAt: Date.now() });
		const hooks = await SessionEnvPlugin({} as never, { bindingTimeoutMs: 10 });
		await expect(hooks['shell.env']!({ cwd: '/work', sessionID: 'ses_a', callID: 'missing' }, { env: {} })).rejects.toThrow('timeout');
		for (const parentID of ['msg_a', 'msg_b']) await hooks.event!({ event: { type: 'message.updated', properties: { info: { sessionID: 'ses_a', role: 'assistant', id: 'as_a', parentID } } } } as never);
		await hooks.event!({ event: { type: 'message.part.updated', properties: { part: { sessionID: 'ses_a', type: 'tool', callID: 'call_a', messageID: 'as_a' } } } } as never);
		await expect(hooks['shell.env']!({ cwd: '/work', sessionID: 'ses_a', callID: 'call_a' }, { env: {} })).rejects.toThrow('ambiguous');
	});

	it('recovers only a unique loopback native ancestry with redirects forbidden, never external lookup', async () => {
		await publishInput(dir, { sessionID: 's', inputID: 'u', conversationId: 'c', generation: 1, systemPrompt: 'p' });
		await readyInput(dir, 's', 'u', { token: 'a'.repeat(64), runId: 'r', thinkingId: 't' });
		const messages = vi.fn(async () => ({ data: [{ info: { sessionID: 's', role: 'assistant', id: 'a', parentID: 'u' }, parts: [{ sessionID: 's', type: 'tool', messageID: 'a', callID: 'call' }] }] }));
		const native = { serverUrl: new URL('http://127.0.0.1:4096'), directory: '/work', client: { session: { messages } } };
		const hooks = await SessionEnvPlugin(native as never, { bindingTimeoutMs: 30 });
		const output = { env: {} as Record<string, string> };
		await hooks['shell.env']!({ cwd: '/work', sessionID: 's', callID: 'call' }, output);
		expect(output.env.AICHAT_RUN_BIND).toBe('a'.repeat(64));
		expect(messages).toHaveBeenCalledWith(expect.objectContaining({ redirect: 'error', path: { id: 's' } }));
		messages.mockClear();
		const external = await SessionEnvPlugin({ ...native, serverUrl: new URL('https://external.invalid') } as never, { bindingTimeoutMs: 5 });
		await expect(external['shell.env']!({ cwd: '/work', sessionID: 's', callID: 'call' }, { env: {} })).rejects.toThrow('timeout');
		expect(messages).not.toHaveBeenCalled();
	});

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
