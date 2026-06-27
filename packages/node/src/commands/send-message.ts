/**
 * REQ-010 S1 — `aichat send-message` CLI.
 *
 * A THIN client run BY the agent inside its session. It accepts ONLY `--content`; the target
 * room + identity are NEVER passed on the command line — node resolves them from the agent's
 * session env var (anti-spoofing). The command POSTs to the node-local loopback capability
 * socket, which looks up the bound room/identity and sends the reply.
 */

import { randomUUID } from 'node:crypto';
import { capabilitySocketPath } from '../capability/endpoint.js';
import { postCapability } from '../capability/client.js';

export async function handleSendMessage(args: string[]): Promise<void> {
	let content = '';
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--content' && args[i + 1]) content = args[++i];
	}

	if (!content.trim()) {
		console.error('Usage: aichat send-message --content "<text>"');
		console.error('       (room and identity are bound automatically from your agent session)');
		process.exit(1);
	}

	const sessionKey = resolveAgentSessionKey();
	if (!sessionKey) {
		console.error('Error: no agent session env (OPENCODE_SESSION_ID / CODEX_THREAD_ID / OPENCLAW_BIND / AICHAT_BIND)');
		process.exit(1);
	}

	const res = await postCapability(capabilitySocketPath(), {
		sessionKey,
		command: 'send-message',
		args: { content: content.trim() },
		idempotencyKey: randomUUID(),
	});

	const ok = res.status === 200 && (res.body as { ok?: boolean })?.ok === true;
	if (ok) {
		const result = (res.body as { result?: unknown }).result;
		console.log(`Message sent: ${JSON.stringify(result)}`);
		return;
	}

	const error = (res.body as { error?: string })?.error ?? `HTTP ${res.status}`;
	console.error(`Error: send-message failed: ${error}`);
	process.exit(1);
}

/**
 * REQ-010 S1/S5 — resolve the agent's session key OUT-OF-BAND from its environment.
 *
 * opencode injects `OPENCODE_SESSION_ID` (via the session-env plugin) → `opencode:<id>`.
 * codex NATIVELY injects `CODEX_THREAD_ID` into its exec shell subprocess → `codex:<id>`.
 * openclaw gets `OPENCLAW_BIND` injected by aichat-claw's `resolve_exec_env` hook (the bare
 * `aiclaw-{uid}-room-{roomId}` binding) → `openclaw:<binding>` (REQ-010 S6 Phase-2).
 * claude-code (CC) reads `AICHAT_BIND` (the same bare `aiclaw-{uid}-room-{roomId}` binding, placed in
 * CC's launch env by `aichat cc-bind`) → `cc:<binding>` (REQ-010 S7). CC has no server: the owner
 * runs `claude` by hand, and CC's bash runs `aichat send-message` to reply.
 * The prefix routes the loopback capability to the owning driver (see capability/session-key.ts).
 * Precedence opencode > codex > openclaw > cc (cc last). Returns undefined when no recognized session
 * env is set — the CLI never accepts a session id (or room/identity) as an argument (anti-spoofing).
 */
export function resolveAgentSessionKey(): string | undefined {
	const opencode = process.env.OPENCODE_SESSION_ID;
	if (opencode) return `opencode:${opencode}`;
	const codex = process.env.CODEX_THREAD_ID;
	if (codex) return `codex:${codex}`;
	const openclaw = process.env.OPENCLAW_BIND;
	if (openclaw) return `openclaw:${openclaw}`;
	const cc = process.env.AICHAT_BIND;
	if (cc) return `cc:${cc}`;
	return undefined;
}
