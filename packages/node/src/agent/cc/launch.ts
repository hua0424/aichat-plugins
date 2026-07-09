import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { REPLY_COMMAND } from '../reply-contract.js';

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
	// cc's anti-injection wrapper is deliberately different from the per-turn buildReplyInstruction, but the
	// COMMAND literal is single-sourced (REPLY_COMMAND) so it can never drift from the other drivers'.
	REPLY_COMMAND +
	'。⚠️ 只有运行这条 bash 命令才会真正发送消息；' +
	'仅仅调用 aichat-reply 技能、或在回答里声称"已发送/我发了"都不会发送任何消息。' +
	'房间和身份由系统经 AICHAT_BIND 自动绑定——绝不要传 --room/--to/收件人/身份参数。' +
	'本轮无需回复时不运行即可（本轮自然结束、不发送任何消息）。' +
	'在你真正运行过该命令之前，绝不要声称已发送。';

/**
 * #132 — build the CC launch-level system prompt: an IDENTITY ANCHOR prepended to {@link CC_REPLY_CONTRACT}.
 *
 * WHY: the headless CC model reads the group transcript verbatim, including `@<name>` mentions of ITSELF.
 * Without a self-name anchor it has no way to know which name it answers to, so it treats `@CCTestAI` as a
 * message to a THIRD party and silently declines to reply (the #132 identity-recognition gap). The anchor
 * tells the model it IS `<displayName>（uid <uid>）`, so a routed message — including a group @-mention of
 * that name — is understood as addressed to it. The display name is resolved from HuLa (getMemberInfo) at
 * the handler and threaded in; when it can't be resolved the anchor still pins the uid.
 *
 * Style matches the existing Chinese reply-contract prose; the contract body is appended UNCHANGED.
 */
export function buildCcSystemPrompt(identity: { displayName?: string; uid: string }): string {
	const who = identity.displayName ? `${identity.displayName}（uid ${identity.uid}）` : `（uid ${identity.uid}）`;
	const anchor =
		`你是本 HuLa 聊天会话的 AI 助理 ${who}。凡系统路由到你这里的消息——包括群聊里对你` +
		`${identity.displayName ? `（@${identity.displayName}）` : ''}的点名——都是在对你说话，` +
		`应据内容按下述约定回复；本轮无需回复时自然结束、不发送即可。\n`;
	return anchor + CC_REPLY_CONTRACT;
}

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
 * CCDriver calls this with the per-session workspace dir (see opencode/workspace deriveWorkspaceDir).
 */
export function writeCcSettings(dir: string, settings: object): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, 'settings.json');
	writeFileSync(path, JSON.stringify(settings, null, 2), 'utf-8');
	return path;
}
