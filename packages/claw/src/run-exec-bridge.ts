import { resolveOpenclawRunBindDir, waitForOpenclawRunBind } from './run-bind.js';

/**
 * #406 — gateway-side `before_tool_call` bridge: the trusted exec hook writes the
 * frozen per-run binding into the exec env.
 *
 * Provenance (read-only, openclaw 2026.6.5 dist bundle
 * `agent-tools.before-tool-call-DILVSJiH.js`): the hook event is
 * `{ toolName, params, ...runId?, ...toolCallId? }` (runId from the trusted internal
 * ctx, toolName already normalized lowercase) and the 2nd-arg ctx is
 * `{ toolName, agentId?, sessionKey?, sessionId?, runId?, toolCallId?, channelId? }`;
 * the returned `{ params }` is merged over the tool params before execution, and the
 * handler may be sync or async. `resolve_exec_env`'s pluginEnv is spread AFTER
 * params.env at exec spawn, so this hook is the ONLY writer of the run key — the
 * resolve path must never emit it (see exec-env.ts).
 *
 * Fail-closed: non-exec tools are left untouched (return undefined); an exec call
 * whose runId has no exact file gets `AICHAT_RUN_BIND: ''` — overwriting/clearing any
 * model-reported or inherited reserved value, never another run's token, never a
 * guess. Raw tokens never enter logs (callers must not log the return value).
 */

/** Reserved single-round binding key: fixed `AICHAT_RUN_BIND` (the #404 CLI contract). */
export const AICHAT_RUN_BIND = 'AICHAT_RUN_BIND';
/** Only the shell-exec tool carries spawns whose env must be bound. */
const EXEC_TOOL = 'exec';

export interface BeforeToolCallInvocation {
	event: { toolName?: unknown; params?: unknown; runId?: unknown; toolCallId?: unknown } | undefined | null;
	ctx?: {
		toolName?: unknown; agentId?: unknown; sessionKey?: unknown; sessionId?: unknown;
		runId?: unknown; toolCallId?: unknown; channelId?: unknown;
	} | undefined | null;
}

export interface RunExecBridgeOptions {
	/** Binding dir; defaults to the shared `AICHAT_OPENCLAW_RUNBIND_DIR` resolution. */
	dir?: string;
	/** Bounded wait budget for a hook firing before the node's accepted publish. */
	timeoutMs?: number;
	intervalMs?: number;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown> : {};
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Pure-ish bridge decision (file read is the only effect). Returns `{ params }` for the
 * gateway to merge, or undefined when the call is not an exec (leave it alone).
 * Never throws — unexpected input fails closed to the stripped env.
 */
export async function handleBeforeToolCall(
	invocation: BeforeToolCallInvocation,
	opts?: RunExecBridgeOptions,
): Promise<{ params: Record<string, unknown> } | undefined> {
	try {
		const event = invocation?.event;
		const toolName = asString(event?.toolName)?.toLowerCase();
		if (toolName !== EXEC_TOOL) return undefined; // ordinary tools: no env to bind
		const runId = asString(event?.runId) ?? asString(invocation?.ctx?.runId);
		const params = asRecord(event?.params);
		const env = asRecord(params.env);
		if (!runId) {
			// No trusted run (legacy/TUI exec): still strip the reserved key so a
			// model-forged or inherited value can never ride along. '' == absent to the CLI.
			return { params: { ...params, env: { ...env, [AICHAT_RUN_BIND]: '' } } };
		}
		const dir = opts?.dir ?? resolveOpenclawRunBindDir();
		const bind = await waitForOpenclawRunBind(dir, runId, { timeoutMs: opts?.timeoutMs, intervalMs: opts?.intervalMs });
		return { params: { ...params, env: { ...env, [AICHAT_RUN_BIND]: bind?.token ?? '' } } };
	} catch {
		return undefined;
	}
}
