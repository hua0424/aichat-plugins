import type { CapabilityResponse, AdminHandler } from './endpoint.js';
import type { CcDriver } from '../agent/cc/cc-driver.js';
import type { OpencodeChatContext } from '../agent/opencode/workspace.js';

/**
 * REQ-010 S7 — the `cc-bind` admin handler.
 *
 * The owner runs `aichat cc-bind --room <id>` to get the copy-paste launch command. Only the running
 * node knows the resolved cc aiclaw uid, so the CLI POSTs `{ admin: "cc-bind", roomId, uid? }` to the
 * loopback capability socket. This handler:
 *   - finds the single `driver.type === 'cc'` identity in the supervisor's agents (errors clearly if
 *     none; requires `uid` to disambiguate if more than one),
 *   - calls that identity's `CcDriver.bind(ccUid, roomId, chatContext)`,
 *   - returns `{ launchCommand, workspaceDir }`.
 *
 * NOT identity-resolved by a sessionKey — it's a setup op. The room/identity binding it produces is
 * itself the thing being set up. chatContext here is minimal: we don't know group-vs-DM/groupkey for
 * an arbitrary room at setup time, so we default to a group room keyed by roomId (the owner can pin a
 * specific workspaceDir via group-config later; the default derives `<base>/<uid>/group/<roomId>`).
 */

/** A cc-bindable agent: a CcDriver-bearing identity. */
export interface CcBindableAgent {
	// REQ-029 (#29): uid is an opaque string.
	uid: string;
	driver: { type: string; bind?: CcDriver['bind'] };
}

/** Find the target cc identity: the sole cc driver, or the one matching `uid` when several exist. */
function findCcAgent(
	agents: ReadonlyArray<CcBindableAgent>,
	uid: string | undefined,
): { agent: CcBindableAgent } | { error: string } {
	const ccAgents = agents.filter((a) => a.driver.type === 'cc' && typeof a.driver.bind === 'function');
	if (ccAgents.length === 0) {
		return { error: 'no cc (claude-code) identity is registered/online' };
	}
	if (ccAgents.length === 1) {
		return { agent: ccAgents[0] };
	}
	if (uid === undefined) {
		const uids = ccAgents.map((a) => a.uid).join(', ');
		return { error: `multiple cc identities (${uids}); pass --uid to disambiguate` };
	}
	const match = ccAgents.find((a) => a.uid === uid);
	if (!match) {
		return { error: `no cc identity with uid ${uid}` };
	}
	return { agent: match };
}

export function ccBindAdminHandler(agents: ReadonlyArray<CcBindableAgent>): AdminHandler {
	return (body: Record<string, unknown>): CapabilityResponse => {
		// REQ-029 (#29): keep roomId/uid as opaque numeric strings (never Number() — >2^53 corrupts).
		const roomId = body.roomId == null ? '' : String(body.roomId);
		if (!/^\d+$/.test(roomId) || roomId === '0') {
			return { status: 400, json: { ok: false, error: 'cc-bind requires a positive integer roomId' } };
		}
		const uid = body.uid === undefined ? undefined : String(body.uid);

		const found = findCcAgent(agents, uid);
		if ('error' in found) {
			return { status: 400, json: { ok: false, error: found.error } };
		}

		const ccUid = found.agent.uid;
		// Minimal chat context: a group room keyed by roomId (default workspace derivation). The owner
		// can later pin a different host path via group-config (workspaceDir override).
		const chatContext: OpencodeChatContext = { roomType: 1, roomId };
		const out = found.agent.driver.bind!(ccUid, roomId, chatContext);
		return {
			status: 200,
			json: { ok: true, result: { launchCommand: out.launchCommand, workspaceDir: out.workspaceDir } },
		};
	};
}
