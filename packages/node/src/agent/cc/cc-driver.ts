import { fileURLToPath } from 'node:url';
import type { AgentDriver, AgentSession } from '../events.js';
import { deriveWorkspaceDir, type OpencodeChatContext } from '../opencode/workspace.js';
import { buildCcSettings, writeCcSettings, buildCcLaunchCommand } from './launch.js';

/**
 * REQ-010 S7 — CcDriver: the FOURTH AgentDriver (after openclaw, opencode, codex), for claude-code.
 *
 * ASYMMETRIC by design. claude-code has NO server: the OWNER manually runs `claude` in a TUI and
 * drives the turns by hand; node never drives a CC turn. So this driver does NOT open turn-driving
 * sessions. Its two real responsibilities are:
 *
 *  (a) `drivesTurns = false` — tells the MessageHandler to NOT trigger the agent loop on inbound
 *      messages for a cc identity. The cc identity's thinking comes ONLY from the side-channel broker
 *      (CcBroker → MessageHandler external-thinking), never from an inbound-triggered loop.
 *  (b) `bind(aiclawUid, roomId, chatContext)` — composes the binding `aiclaw-{uid}-room-{roomId}`,
 *      derives the per-conversation workspace dir, writes the CC `settings.json` (lifecycle hooks +
 *      `aichat` bash permission), and returns the owner copy-paste launch command. The owner runs
 *      that command; CC's bash then replies to the room via `aichat send-message` (AICHAT_BIND in env
 *      → `cc:<binding>` → the capability endpoint → resolveSession), and CC's hooks mirror thinking
 *      into the broker. AICHAT_BIND IS the binding string directly (manager-approved; like S6's
 *      OPENCLAW_BIND — no opaque token, no store; resolveSession is a pure parse). The binding-string
 *      is forgeable by a malicious agent; accepted for single-owner (tracked as BL-014).
 *
 * `openSession` cannot return a meaningful AgentSession (there is no turn to drive), so it THROWS a
 * clear error. It is never reached in production because `drivesTurns === false` stops the handler
 * from calling it; throwing (vs. a fake empty session) avoids emitting spurious empty thinking.
 *
 * `resolveSession` mirrors OpenclawDriver: a pure parse of the bare binding (the capability endpoint
 * strips the `cc:` prefix first). `parseCcBinding` is the shared parser reused by both
 * `resolveSession` AND the broker's `resolve`.
 */

/** The owner copy-paste launch instructions returned by `bind()`. */
export interface CcBindInstructions {
	/** The binding string `aiclaw-{uid}-room-{roomId}` (placed in CC's env as AICHAT_BIND). */
	token: string;
	/** The full `cd … && AICHAT_BIND=… claude --settings …` command the owner pastes to start CC. */
	launchCommand: string;
	/** Absolute path of the written CC settings.json. */
	settingsPath: string;
	/** Absolute per-conversation workspace dir CC launches in. */
	workspaceDir: string;
}

export interface CcDriverDeps {
	/** Root under which per-conversation CC workspaces are derived (e.g. ~/.aichat/cc/workspace). */
	workspaceBase: string;
	/** The node-local CcBroker port the generated hooks POST to. */
	brokerPort: number;
}

/**
 * Parse a CC binding string `aiclaw-{uid}-room-{roomId}` → `{ aiclawUid, roomId }`, or undefined on
 * any garbage/prefixed input. Shared by `CcDriver.resolveSession` AND `CcBroker.resolve` so the two
 * paths can never diverge. A still-prefixed `cc:aiclaw-…` must never arrive here (the endpoint strips
 * `cc:` first) and is rejected by the strict `^…$` anchors.
 */
export function parseCcBinding(binding: string): { aiclawUid: string; roomId: string } | undefined {
	const m = /^aiclaw-(\d+)-room-(\d+)$/.exec(binding);
	if (!m) return undefined;
	// REQ-029 (#29): opaque strings, never Number() (>2^53 corrupts routing).
	return { aiclawUid: m[1], roomId: m[2] };
}

export class CcDriver implements AgentDriver {
	readonly type = 'cc';

	/** Node does NOT drive cc turns — the owner drives the TUI by hand (see class doc). */
	readonly drivesTurns = false;

	private readonly workspaceBase: string;
	private readonly brokerPort: number;

	constructor(deps: CcDriverDeps) {
		this.workspaceBase = deps.workspaceBase;
		this.brokerPort = deps.brokerPort;
	}

	async connect(): Promise<void> {
		// No-op: claude-code has no server to connect to (the owner runs the TUI).
	}

	async disconnect(): Promise<void> {
		// No-op: no shared server / no per-driver resources.
	}

	/**
	 * Pure parse of the bare binding back to its bound identity+room. The capability endpoint strips
	 * the `cc:` prefix before calling this (same contract as opencode/codex/openclaw). Returns
	 * undefined on any unparseable/garbage input (incl. a still-prefixed `cc:…`).
	 */
	resolveSession(sessionKey: string): { aiclawUid: string; roomId: string } | undefined {
		return parseCcBinding(sessionKey);
	}

	/**
	 * NOT supported: CC is owner-driven, so there is no node-driven turn to open. Throws a clear error.
	 * Never reached in production (`drivesTurns === false` keeps the handler from calling it). Use
	 * `bind()` instead to get the owner launch instructions.
	 */
	async openSession(): Promise<AgentSession> {
		throw new Error('cc is owner-driven: node does not drive cc turns (use CcDriver.bind() to launch CC)');
	}

	/**
	 * Compose the binding, derive the workspace dir, write CC's settings.json, and build the owner
	 * copy-paste launch command. Called by the `cc-bind` admin route (setup op), NOT by the handler.
	 */
	bind(aiclawUid: string, roomId: string, chatContext: OpencodeChatContext): CcBindInstructions {
		const token = `aiclaw-${aiclawUid}-room-${roomId}`;
		const workspaceDir = deriveWorkspaceDir(this.workspaceBase, aiclawUid, chatContext);
		const settingsPath = writeCcSettings(workspaceDir, buildCcSettings(this.brokerPort));
		// REQ-011 S2: resolve the sibling `aichat-channel` MCP bin (dist/agent/cc/channel-mcp.js) so the
		// launch command also registers the persistent channels MCP (single owner paste).
		const channelMcpBin = fileURLToPath(new URL('./channel-mcp.js', import.meta.url));
		const launchCommand = buildCcLaunchCommand({ token, workspaceDir, settingsPath, channelMcpBin });
		return { token, launchCommand, settingsPath, workspaceDir };
	}
}
