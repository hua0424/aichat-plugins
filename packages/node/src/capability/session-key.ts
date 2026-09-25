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
 * as opencode/codex. Its id is now a node-minted OPAQUE token (BL-014 #141) — OpenclawDriver.resolveSession
 * resolves it via the shared `BindTokenStore` (no longer a parse of a plaintext binding).
 */
export const KNOWN_PREFIXES: Record<string, string> = {
	'opencode:': 'opencode',
	'codex:': 'codex',
	'openclaw:': 'openclaw',
	// REQ-010 S7: claude-code. Its id is a node-minted OPAQUE token (BL-014 #141), injected as the agent's
	// `AICHAT_BIND` env — CcHeadlessDriver.resolveSession resolves it via the `BindTokenStore` (not a parse).
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
	// REQ-029 (#29): uid is an opaque string end-to-end.
	uid: string;
	api: HulaApiClient;
}

/** The resolved binding: the bound identity+room + the per-identity api client to reply through. */
export interface BoundSession {
	aiclawUid: string;
	roomId: string;
	apiClient: HulaApiClient;
}

/**
 * REQ-010 S5 — prefix-routed session resolution.
 *
 * Query registered drivers of the known type; only the driver registered for the resolved identity
 * may claim its room. Reject conflicting claims instead of selecting the first same-type driver.
 */
export function resolveBoundSession(
	sessionKey: string,
	agents: ReadonlyArray<BindableAgent>,
): BoundSession | undefined {
	const parsed = parseSessionKey(sessionKey);
	if (!parsed) return undefined;

	let match: BoundSession | undefined;
	for (const agent of agents) {
		if (agent.driver.type !== parsed.agentType || !agent.driver.resolveSession) continue;
		const resolved = agent.driver.resolveSession(parsed.id);
		if (!resolved || resolved.aiclawUid !== agent.uid) continue;
		if (match) return undefined; // native id must not select among multiple registered identities
		match = { aiclawUid: agent.uid, roomId: resolved.roomId, apiClient: agent.api };
	}
	return match;
}
