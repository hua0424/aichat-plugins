/**
 * REQ-010 S6 Phase-2 — openclaw `resolve_exec_env` injection helper.
 *
 * The openclaw agent CAN run shell (`exec` tool), so the unified `aichat send-message` CLI works
 * inside it — IF it can recover its room binding. openclaw fires the `resolve_exec_env` hook with a
 * ctx whose `sessionKey` is the openclaw-normalized form `agent:main:aiclaw-{uid}-room-{roomId}`
 * (aichat-node sends the bare `aiclaw-{uid}-room-{roomId}`; openclaw wraps it with `agent:main:`).
 *
 * This pure helper turns that sessionKey into the env vars to MERGE into the exec invocation. We
 * strip the `agent:main:` namespace prefix and, ONLY if the remainder is a well-formed binding,
 * export it as `OPENCLAW_BIND` — which the CLI's `resolveAgentSessionKey()` reads to emit an
 * `openclaw:<binding>` capability session key. Anything else returns `{}` (inject nothing): we never
 * throw and never inject a malformed binding, so a missing/odd sessionKey is a safe no-op.
 */

const AGENT_MAIN_PREFIX = 'agent:main:';
const BINDING_RE = /^aiclaw-\d+-room-\d+$/;

/**
 * Shape-tolerant sessionKey extraction for the `resolve_exec_env` hook (mirrors the Phase-1 probe).
 * The real handler signature is `(event, ctx)` with sessionKey on the 2nd arg, but openclaw versions
 * have varied — so prefer `ctx.sessionKey`, then fall back to `event.ctx.sessionKey` / `event.sessionKey`.
 * Returns undefined when none is a string. Never throws.
 */
export function extractExecEnvSessionKey(
	event: { ctx?: { sessionKey?: string | null }; sessionKey?: string | null } | undefined | null,
	ctx?: { sessionKey?: string | null } | undefined | null,
): string | undefined {
	const candidates = [ctx?.sessionKey, event?.ctx?.sessionKey, event?.sessionKey];
	for (const c of candidates) {
		if (typeof c === 'string' && c.length > 0) return c;
	}
	return undefined;
}

export function buildOpenclawExecEnv(sessionKey: string | null | undefined): Record<string, string> {
	if (typeof sessionKey !== 'string') return {};
	if (!sessionKey.startsWith(AGENT_MAIN_PREFIX)) return {};
	const binding = sessionKey.slice(AGENT_MAIN_PREFIX.length);
	if (!BINDING_RE.test(binding)) return {};
	return { OPENCLAW_BIND: binding };
}
