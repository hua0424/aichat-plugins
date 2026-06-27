import type { AgentEvent } from '../events.js';

/**
 * REQ-010 S5 — pure codex ThreadEvent → AgentEvent mapping.
 *
 * Translates the @openai/codex-sdk@0.142.3 streamed `ThreadEvent` vocabulary into the
 * driver-agnostic AgentEvent stream the MessageHandler consumes. PURE: no clock, no I/O.
 *
 * NOT this function's job:
 *  - capturing `thread.started.thread_id` for the session store (the SESSION layer does that, and
 *    it is NOT an AgentEvent — returns null here so it is never yielded);
 *  - tool start/end de-dup by item id (stateless here — emits a tool event per command_execution
 *    status; the SESSION layer collapses duplicates);
 *  - the real `durationMs` for `done` (the session fills it — here it is 0).
 *
 * Mapping (mirrors opencode where the model's TEXT is thinking; the real reply goes out-of-band via
 * the `aichat send-message` capability, never through these events):
 *  - reasoning              → thinking (the agent's reasoning text)
 *  - agent_message          → thinking (the model's text is analysis, NOT the user-facing reply)
 *  - command_execution      → tool (in_progress→start; completed/failed→end)  [item-level shell run]
 *  - error (item)           → error
 *  - turn.completed         → done
 *  - turn.failed / error    → error (fatal)
 *  - everything else        → null (ignored)
 */
export function mapCodexEvent(evt: unknown): AgentEvent | null {
	if (!evt || typeof evt !== 'object') return null;
	const e = evt as { type?: unknown };
	if (typeof e.type !== 'string') return null;

	switch (e.type) {
		case 'item.started':
		case 'item.updated':
		case 'item.completed':
			return mapCodexItem((e as { item?: unknown }).item);

		case 'turn.completed':
			// session fills the real durationMs; here it is a placeholder.
			return { type: 'done', durationMs: 0 };

		case 'turn.failed': {
			const err = (e as { error?: { message?: unknown } }).error;
			return { type: 'error', message: stringifyMessage(err?.message, 'codex turn failed') };
		}

		case 'error':
			return { type: 'error', message: stringifyMessage((e as { message?: unknown }).message, 'codex error') };

		// thread.started / turn.started → not AgentEvents (the session handles thread.started).
		default:
			return null;
	}
}

/**
 * PURE — map a single codex `ThreadItem` to at most one AgentEvent.
 * Exposed for unit-testing the item-shape branches in isolation.
 */
export function mapCodexItem(item: unknown): AgentEvent | null {
	if (!item || typeof item !== 'object') return null;
	const it = item as {
		type?: unknown;
		text?: unknown;
		command?: unknown;
		status?: unknown;
		message?: unknown;
	};
	if (typeof it.type !== 'string') return null;

	switch (it.type) {
		case 'reasoning':
		case 'agent_message': {
			// The model's reasoning/text is thinking/analysis — never the user-facing reply.
			const text = typeof it.text === 'string' ? it.text : '';
			return { type: 'thinking', text };
		}

		case 'command_execution': {
			const status = it.status;
			let phase: 'start' | 'end';
			if (status === 'in_progress') phase = 'start';
			else if (status === 'completed' || status === 'failed') phase = 'end';
			else return null; // unknown status → ignore
			return { type: 'tool', name: deriveToolName(it.command), phase };
		}

		case 'error':
			return { type: 'error', message: stringifyMessage(it.message, 'codex item error') };

		// file_change / mcp_tool_call / web_search / todo_list → ignore (no AgentEvent vocabulary).
		default:
			return null;
	}
}

/** Derive a short, human-readable tool name from a command_execution's command string. */
function deriveToolName(command: unknown): string {
	if (typeof command !== 'string' || command.trim() === '') return 'shell';
	// Use the leading token (the program) so the activity label reads e.g. "bash"/"ls", not the
	// full command line. Falls back to 'shell' for an empty/odd command.
	const first = command.trim().split(/\s+/)[0];
	return first && first.length > 0 ? first : 'shell';
}

/** Best-effort stringify of a codex error message field into a human-readable message. */
function stringifyMessage(message: unknown, fallback: string): string {
	if (typeof message === 'string' && message.length > 0) return message;
	return fallback;
}
