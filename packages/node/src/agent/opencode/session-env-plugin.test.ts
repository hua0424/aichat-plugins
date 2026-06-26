import { describe, it, expect } from 'vitest';
import { SessionEnvPlugin } from './session-env-plugin.js';

/**
 * REQ-010 S1: the plugin's ONLY job is to copy the opencode session id into the shell env so
 * `aichat send-message` can resolve its bound (aiclaw, room). Drive the real `shell.env` hook.
 */
describe('SessionEnvPlugin', () => {
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
	});

	it('does NOT set OPENCODE_SESSION_ID when sessionID is absent', async () => {
		const output = await runHook({ cwd: '/work' });
		expect('OPENCODE_SESSION_ID' in output.env).toBe(false);
	});

	it('preserves any env the hook already received', async () => {
		const hooks = await SessionEnvPlugin({} as never, undefined);
		const hook = hooks['shell.env'];
		if (!hook) throw new Error('shell.env hook not registered');
		const output = { env: { EXISTING: '1' } as Record<string, string> };
		await hook({ cwd: '/work', sessionID: 'ses_y' }, output);
		expect(output.env.EXISTING).toBe('1');
		expect(output.env.OPENCODE_SESSION_ID).toBe('ses_y');
	});
});
