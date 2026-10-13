import type { Plugin } from '@opencode-ai/plugin';
import { readRunBindFile, resolveRunBindDir } from './run-bind.js';

/**
 * REQ-010 S1: opencode does NOT natively expose the session id to the bash tool. This plugin
 * injects OPENCODE_SESSION_ID into every shell execution via the `shell.env` hook, so the
 * `aichat send-message` CLI can read it and node can resolveSession → (aiclaw, room). This is
 * the opencode-native binding mechanism (analogous to CC's AICHAT_BIND), not a capability/tool.
 *
 * #405: the same hook carries the frozen per-run reply binding. The node driver publishes
 * `run-bind/<sessionID>.json` BEFORE submitting the prompt; the hook resolves sessionID →
 * token with no notion of "the current run", overwriting any inherited AICHAT_RUN_BIND.
 * No file (or an unreadable/malformed one) → EMPTY value: fail-closed legacy-unknown with
 * inheritance stripped, never another run's token and never a current-run guess.
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
		// Scope to THIS tool invocation; without a native session no inherited credential may route
		// a shell command to another identity. Empty overrides suppress process env inheritance.
		// #405: the frozen run binding rides the same hook. It is resolved per sessionID from the
		// driver-published file — never from process env, never a "current run" guess. Absent →
		// empty (fail-closed): the CLI then sends an unassociated legacy request, honestly unknown.
		const binding = input.sessionID === undefined ? undefined
			: await readRunBindFile(resolveRunBindDir(), input.sessionID);
		Object.assign(output.env, {
			OPENCODE_SESSION_ID: input.sessionID ?? '',
			AICHAT_RUN_BIND: binding?.token ?? '',
			CODEX_THREAD_ID: '', OPENCLAW_BIND: '', AICHAT_BIND: '', AICHAT_CONTEXT_KEY: '',
		});
	},
});

export default SessionEnvPlugin;
