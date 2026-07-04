/**
 * REQ-010 S6 Phase-2 / #141 B+ — openclaw `resolve_exec_env` injection helper.
 *
 * The openclaw agent CAN run shell (`exec` tool), so the unified `aichat send-message` CLI works
 * inside it — IF it can recover an unforgeable capability token. openclaw fires the `resolve_exec_env`
 * hook with a ctx whose `sessionKey` is the openclaw-normalized COMPOUND form
 * `agent:main:<token>:aiclaw-{uid}-room-{roomId}` (aichat-node builds `<token>:<binding>` — see
 * OpenclawDriver.openSession; openclaw wraps it with `agent:main:`).
 *
 * ONE sessionKey serves TWO paths that must not be conflated:
 *   • the in-gateway hula_send_message TOOL parses ctx.sessionKey's TAIL binding to find its room;
 *   • THIS CLI/exec-env path extracts the PREFIX opaque token.
 * We strip the `agent:main:` namespace prefix, split the compound into `<token>:<binding>`, and export
 * the BARE token as `OPENCLAW_BIND` — which the CLI's `resolveAgentSessionKey()` reads to emit an
 * `openclaw:<token>` capability session key that the node resolves via an EXACT store lookup. Anything
 * that is not a well-formed compound returns `{}` (inject nothing): we never throw and never inject a
 * malformed value, so a missing/odd/non-compound sessionKey is a safe no-op.
 */

const AGENT_MAIN_PREFIX = 'agent:main:';
// Split a compound `<token>:<binding>` into its opaque-token prefix (group 1) and binding suffix.
// The token is base64url (`[A-Za-z0-9_-]`, no `:`) and the `$`-anchored binding has no `:`, so the
// single `:` between them is unambiguous; `.+` greedily backtracks to it.
const COMPOUND_RE = /^(.+):(aiclaw-\d+-room-\d+)$/;

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
	const rest = sessionKey.slice(AGENT_MAIN_PREFIX.length); // `<token>:aiclaw-{uid}-room-{roomId}`
	const m = COMPOUND_RE.exec(rest); // split token prefix from binding suffix
	if (!m) return {}; // not a compound → inject nothing (safe no-op)
	return { OPENCLAW_BIND: m[1] }; // the BARE opaque token → CLI emits `openclaw:<token>`
}
