import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

/**
 * REQ-010 S7 chunk 2 — claude-code (CC) side-channel config generators.
 *
 * CC has no gateway/server: node mirrors a CC turn into the room's thinking panel via claude-code
 * **command hooks** that POST to the node-local broker (`CcBroker`, src/agent/cc/broker.ts), and the
 * owner launches CC by hand with a copy-paste command. This module is the pure-ish generator layer:
 *   - `buildCcHooksSettings` / `buildCcSettings` — the `settings.json` CC loads via `--settings`
 *   - `writeCcSettings` — write that settings object into the per-session workspace dir
 * The CCDriver (chunk 3) consumes these; nothing here mints tokens or knows about sessions.
 *
 * VERIFIED hook mechanism (claude-code 2.1.195, chunk-1 probe): a command hook fires in interactive
 * and `-p` mode, receives the hook JSON on stdin, reads `$AICHAT_BIND` from CC's launch env, and
 * POSTs to the broker. The broker dispatches by `hook_event_name`, so all events hit one URL.
 *
 * REQ-018 — the cc reply contract + identity anchor are RETIRED from this file: they are now
 * server-fetched templates (agent/prompt-templates.ts) rendered into `--append-system-prompt` by the
 * headless driver (cc/headless-driver.ts). This file only generates hooks/settings now.
 */

/** The single broker URL path all hooks POST to (the broker accepts any path; we pin /hook). */
const BROKER_HOOK_PATH = '/hook';

/** The aichat reply CLI permission rule — lets the agent run `aichat send-message` unattended. */
const AICHAT_BASH_RULE = 'Bash(aichat:*)';

/** A single claude-code command-hook entry. */
interface CcCommandHook {
	type: 'command';
	command: string;
	async: true;
}

/** A claude-code matcher group for one event. */
interface CcHookMatcher {
	matcher: string;
	hooks: CcCommandHook[];
}

/** The claude-code `hooks` object keyed by event name. */
export type CcHooks = Record<string, CcHookMatcher[]>;

/** The full claude-code settings object CC loads via `--settings`. */
export interface CcSettings {
	hooks: CcHooks;
	permissions: { allow: string[] };
}

/**
 * Build the `curl` command a hook runs: POST the hook JSON (arriving on stdin via `@-`) to the
 * broker with the binding bearer token. `$AICHAT_BIND` expands at hook-run time in CC's env, so the
 * token is never baked into settings.json (settings are per-session but the binding stays in env).
 */
function brokerCurl(brokerPort: number): string {
	return (
		`curl -sS -X POST -H "Authorization: Bearer $AICHAT_BIND" ` +
		`--data-binary @- http://127.0.0.1:${brokerPort}${BROKER_HOOK_PATH}`
	);
}

/** One async command-hook matcher group for an event (matcher `*` = all tools/messages). */
function hookEntry(brokerPort: number): CcHookMatcher {
	return {
		matcher: '*',
		hooks: [{ type: 'command', command: brokerCurl(brokerPort), async: true }],
	};
}

/**
 * (1) The claude-code `hooks` object wiring CC's lifecycle events → the node broker. Each event is a
 * non-blocking (`async: true`) command hook POSTing to `http://127.0.0.1:<brokerPort>/hook`. The
 * broker routes by `hook_event_name`, so one URL serves all events.
 *
 *   UserPromptSubmit → lifecycle (ignored by the broker; the handler sends THINKING_START)
 *   PostToolUse      → broker routes a `{tool}` event (matcher `*` = every tool)
 *   Stop             → broker flushes (the reply goes via the CLI, not here)
 *   SessionStart     → lifecycle (turn boot; ignored by the broker)
 *
 * (#120) There is NO MessageDisplay hook: THINKING is teed from the driver's stdout (headless-driver.ts
 * teeOutput), not sourced from a hook — the MessageDisplay payload carried its text in `delta`, not the
 * `content` the broker read, so that path never delivered panel content.
 */
export function buildCcHooksSettings(brokerPort: number): CcHooks {
	const entry = () => [hookEntry(brokerPort)];
	return {
		UserPromptSubmit: entry(),
		PostToolUse: entry(),
		Stop: entry(),
		SessionStart: entry(),
	};
}

/**
 * (2) The full settings object: the lifecycle hooks PLUS the `Bash(aichat:*)` permission so the
 * agent can run the `aichat send-message` reply CLI unattended (CC's interactive TUI would otherwise
 * prompt per call). Minimal by design — only what CC needs to mirror + reply.
 */
export function buildCcSettings(brokerPort: number): CcSettings {
	return {
		hooks: buildCcHooksSettings(brokerPort),
		permissions: { allow: [AICHAT_BASH_RULE] },
	};
}

/**
 * (3) Write `settings.json` into `dir` (mkdir -p first), returning its absolute path. Pure IO — the
 * CCDriver calls this with the per-session workspace dir (see agent/workspace deriveWorkspaceDir).
 */
export function writeCcSettings(dir: string, settings: object): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, 'settings.json');
	writeFileSync(path, JSON.stringify(settings, null, 2), 'utf-8');
	return path;
}
