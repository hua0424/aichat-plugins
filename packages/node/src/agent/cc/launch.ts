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

/**
 * REQ-010 #102 — the reply contract injected as a CC launch-level system prompt
 * (`claude --append-system-prompt`). This is the CC analog of the per-turn role-prompt that
 * node-driven agents (codex/opencode) get injected each turn: CC, being owner-driven in a TUI,
 * gets NO per-turn role-prompt, so without this it relies on the `aichat-reply` skill alone and
 * conflates "invoking the skill" with "sending" — the #102 bug (CC narrated "已发" but never ran
 * `aichat send-message`, so the DB stayed empty).
 *
 * Injecting it as a launch FLAG (not a workspace CLAUDE.md) makes it: present on EVERY turn,
 * immune to `/clear` (a launch flag is not part of conversation state), and cwd-independent (no
 * dependence on the owner running CC inside a particular workspace). VERIFIED supported +
 * functional on claude-code 2.1.195.
 */
export const CC_REPLY_CONTRACT =
	'你是 HuLa 聊天会话里的 AI 助理。要把回复发送到当前聊天，你必须在 bash 中实际运行命令：' +
	'aichat send-message --content "<你的回复>"。⚠️ 只有运行这条 bash 命令才会真正发送消息；' +
	'仅仅调用 aichat-reply 技能、或在回答里声称"已发送/我发了"都不会发送任何消息。' +
	'房间和身份由系统经 AICHAT_BIND 自动绑定——绝不要传 --room/--to/收件人/身份参数。' +
	'本轮无需回复时不运行即可（本轮自然结束、不发送任何消息）。' +
	'在你真正运行过该命令之前，绝不要声称已发送。';

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
 * REQ-011 S2 — the persistent `aichat-channel` MCP registration command. CC's *channels* subsystem
 * (the inbound-DM path) only wires user-scoped registered MCPs; a `--mcp-config` MCP is invisible to
 * it. So we register `aichat-channel` persistently at user scope. `remove … 2>/dev/null` first makes
 * it idempotent (swallows the "not found" on the first run / re-points a stale entry); AICHAT_BIND is
 * read from the inherited launch env, so no `-e` is needed.
 */
export function buildCcChannelMcpRegisterCommand(channelMcpBin: string): string {
	return (
		`claude mcp remove aichat-channel -s user 2>/dev/null; ` +
		`claude mcp add aichat-channel -s user -t stdio -- node ${shellQuote(channelMcpBin)}`
	);
}

/**
 * (4) The owner copy-paste launch command. Returned by CCDriver.openSession as bindInstructions:
 *   cd <workspaceDir> && AICHAT_BIND=<token> <claudeBin|claude> --settings <settingsPath>
 * `AICHAT_BIND` puts the binding token in CC's env so the hooks' `$AICHAT_BIND` resolves at run time.
 * Paths and token are single-quoted (workspaceDir/settingsPath may contain spaces; token stays quoted
 * even though it's URL-safe base64). The command name (`claude` or override) is quoted too so an
 * override path with spaces still works; a bare `claude` quotes harmlessly to find it on PATH.
 *
 * REQ-010 #102: the reply contract (`CC_REPLY_CONTRACT`) is appended as `--append-system-prompt`
 * so it is present every turn, survives `/clear`, and is cwd-independent. It contains quotes/spaces/
 * `⚠️` so it MUST be `shellQuote`d — the contract is a single quoted arg and never breaks the `&&`
 * or the flags, keeping the launch command a single valid shell line.
 *
 * REQ-011 S2: `--dangerously-load-development-channels server:aichat-channel` opts the launched CC
 * into the channels subsystem backed by the `aichat-channel` MCP (inbound DM delivery). When
 * `channelMcpBin` is given, the persistent MCP register command is PREPENDED (`… ; … && cd …`) so the
 * owner's single paste registers the MCP and launches CC in one shot.
 */
export function buildCcLaunchCommand(opts: {
	token: string;
	workspaceDir: string;
	settingsPath: string;
	claudeBin?: string;
	channelMcpBin?: string;
}): string {
	const bin = opts.claudeBin ? shellQuote(opts.claudeBin) : 'claude';
	const launch =
		`cd ${shellQuote(opts.workspaceDir)} && ` +
		`AICHAT_BIND=${shellQuote(opts.token)} ${bin} ` +
		`--settings ${shellQuote(opts.settingsPath)} ` +
		`--append-system-prompt ${shellQuote(CC_REPLY_CONTRACT)} ` +
		`--dangerously-load-development-channels server:aichat-channel`;
	return opts.channelMcpBin ? `${buildCcChannelMcpRegisterCommand(opts.channelMcpBin)} && ${launch}` : launch;
}
