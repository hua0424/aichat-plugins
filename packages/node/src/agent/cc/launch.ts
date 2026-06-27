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
 *   - `buildCcLaunchCommand` — the owner copy-paste launch command
 * The CCDriver (chunk 3) consumes these; nothing here mints tokens or knows about sessions.
 *
 * VERIFIED hook mechanism (claude-code 2.1.195, chunk-1 probe): a command hook fires in interactive
 * and `-p` mode, receives the hook JSON on stdin, reads `$AICHAT_BIND` from CC's launch env, and
 * POSTs to the broker. The broker dispatches by `hook_event_name`, so all events hit one URL.
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
 *   UserPromptSubmit → broker begins the external thinking session
 *   PostToolUse      → broker mirrors a `[工具] ...` delta (matcher `*` = every tool)
 *   MessageDisplay   → broker mirrors assistant thinking text as a delta
 *   Stop             → broker finalizes the thinking session (the reply goes via the CLI, not here)
 *   SessionStart     → broker begins the session (turn boot)
 */
export function buildCcHooksSettings(brokerPort: number): CcHooks {
	const entry = () => [hookEntry(brokerPort)];
	return {
		UserPromptSubmit: entry(),
		PostToolUse: entry(),
		MessageDisplay: entry(),
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
 * CCDriver calls this with the per-session workspace dir (see opencode/workspace deriveWorkspaceDir).
 */
export function writeCcSettings(dir: string, settings: object): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, 'settings.json');
	writeFileSync(path, JSON.stringify(settings, null, 2), 'utf-8');
	return path;
}

/**
 * POSIX single-quote a value so spaces, quotes, `&`, `$`, etc. are all literal. Wrap in single quotes
 * and escape any embedded single quote by closing the quote, emitting an escaped quote, and reopening:
 * `'` → `'\''`. Safe for arbitrary paths and the URL-safe-base64 token alike.
 */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * (4) The owner copy-paste launch command. Returned by CCDriver.openSession as bindInstructions:
 *   cd <workspaceDir> && AICHAT_BIND=<token> <claudeBin|claude> --settings <settingsPath>
 * `AICHAT_BIND` puts the binding token in CC's env so the hooks' `$AICHAT_BIND` resolves at run time.
 * Paths and token are single-quoted (workspaceDir/settingsPath may contain spaces; token stays quoted
 * even though it's URL-safe base64). The command name (`claude` or override) is quoted too so an
 * override path with spaces still works; a bare `claude` quotes harmlessly to find it on PATH.
 */
export function buildCcLaunchCommand(opts: {
	token: string;
	workspaceDir: string;
	settingsPath: string;
	claudeBin?: string;
}): string {
	const bin = opts.claudeBin ? shellQuote(opts.claudeBin) : 'claude';
	return (
		`cd ${shellQuote(opts.workspaceDir)} && ` +
		`AICHAT_BIND=${shellQuote(opts.token)} ${bin} ` +
		`--settings ${shellQuote(opts.settingsPath)}`
	);
}
