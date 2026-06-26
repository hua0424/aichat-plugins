import type { Plugin } from '@opencode-ai/plugin';

/**
 * REQ-010 S1: opencode does NOT natively expose the session id to the bash tool. This plugin
 * injects OPENCODE_SESSION_ID into every shell execution via the `shell.env` hook, so the
 * `aichat send-message` CLI can read it and node can resolveSession → (aiclaw, room). This is
 * the opencode-native binding mechanism (analogous to CC's AICHAT_BIND), not a capability/tool.
 *
 * The `shell.env` hook signature is taken verbatim from the installed `@opencode-ai/plugin`
 * `Hooks` type (dist/index.d.ts): input `{ cwd: string; sessionID?: string; callID?: string }`,
 * output `{ env: Record<string, string> }`.
 */
export const SessionEnvPlugin: Plugin = async () => ({
	'shell.env': async (
		input: { cwd: string; sessionID?: string; callID?: string },
		output: { env: Record<string, string> },
	) => {
		if (input.sessionID) {
			output.env.OPENCODE_SESSION_ID = input.sessionID;
		}
	},
});

export default SessionEnvPlugin;
