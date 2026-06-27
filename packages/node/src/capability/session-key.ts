/**
 * REQ-010 S5 — capability session-key prefix discipline.
 *
 * The agent's `aichat send-message` CLI carries ONLY a prefixed session key (never room/identity).
 * `resolveAgentSessionKey()` (src/commands/send-message.ts) emits `opencode:<OPENCODE_SESSION_ID>`.
 * The capability endpoint must require a KNOWN agent-type prefix and route by it, so an
 * unprefixed/unknown key never resolves and never reaches a capability.
 */

import type { AgentDriver } from '../agent/events.js';
import type { HulaApiClient } from '../api/hula-api.js';

/** Known session-key prefix → the AgentDriver.type that owns that key namespace.
 *
 * `openclaw:` (REQ-010 S6 Phase-2) routes openclaw agent replies through the same unified CLI path
 * as opencode/codex. Its id is the bare binding `aiclaw-{uid}-room-{roomId}` — OpenclawDriver.resolveSession
 * parses it directly (no store: openclaw's binding IS the sessionKey).
 */
export const KNOWN_PREFIXES: Record<string, string> = {
	'opencode:': 'opencode',
	'codex:': 'codex',
	'openclaw:': 'openclaw',
	// REQ-010 S7: claude-code. Its id is the bare binding `aiclaw-{uid}-room-{roomId}` (read from the
	// agent's `AICHAT_BIND` env) — CcDriver.resolveSession parses it directly (no store: like openclaw).
	'cc:': 'cc',
};

/**
 * Parse a capability session key into its agent type + driver-scoped id.
 *
 * Returns `undefined` when no KNOWN prefix matches — that includes a raw/unprefixed key, an unknown
 * prefix, and a known prefix with an empty id (`opencode:`). A defined result guarantees a known
 * agentType and a non-empty id.
 */
export function parseSessionKey(sessionKey: string): { agentType: string; id: string } | undefined {
	for (const [prefix, agentType] of Object.entries(KNOWN_PREFIXES)) {
		if (sessionKey.startsWith(prefix)) {
			const id = sessionKey.slice(prefix.length);
			if (id.length === 0) return undefined;
			return { agentType, id };
		}
	}
	return undefined;
}

/** A supervised agent, narrowed to what session routing needs: its driver, uid, and per-identity api. */
export interface BindableAgent {
	driver: AgentDriver;
	uid: number;
	api: HulaApiClient;
}

/** The resolved binding: the bound identity+room + the per-identity api client to reply through. */
export interface BoundSession {
	aiclawUid: number;
	roomId: number;
	apiClient: HulaApiClient;
}

/**
 * REQ-010 S5 — prefix-routed session resolution.
 *
 * Parse `sessionKey` for a known prefix, then route ONLY to the agent whose `driver.type` matches the
 * prefix's agent type AND implements `resolveSession`. Ask that driver to resolve the (prefix-stripped)
 * id back to its bound `{ aiclawUid, roomId }`, then map to the OWNER agent's api (the agent whose uid
 * equals the resolved `aiclawUid`). This replaces the old try-every-driver loop: an unprefixed/unknown
 * key, or a prefix with no matching/resolving driver, yields `undefined`.
 */
export function resolveBoundSession(
	sessionKey: string,
	agents: ReadonlyArray<BindableAgent>,
): BoundSession | undefined {
	const parsed = parseSessionKey(sessionKey);
	if (!parsed) return undefined;

	const router = agents.find((a) => a.driver.type === parsed.agentType && a.driver.resolveSession);
	if (!router) return undefined;

	const resolved = router.driver.resolveSession!(parsed.id);
	if (!resolved) return undefined;

	const owner = agents.find((a) => a.uid === resolved.aiclawUid);
	if (!owner) return undefined;

	return { aiclawUid: resolved.aiclawUid, roomId: resolved.roomId, apiClient: owner.api };
}
