import type { AgentEvent } from '../events.js';

/**
 * REQ-008 #77 — pure opencode-event → AgentEvent mapping.
 *
 * Translates the opencode SDK SSE event vocabulary (@opencode-ai/sdk@1.17.9) into
 * the driver-agnostic AgentEvent stream the MessageHandler consumes. PURE: no clock,
 * no I/O, one event in → at most one AgentEvent out (or null to ignore).
 *
 * NOT this function's job: tool start/end de-dup by callID (it is stateless per event,
 * so it emits a tool event per state-status; the SESSION layer collapses duplicates),
 * and the real `durationMs` for `done` (the session fills it — here it is 0).
 *
 * Always filtered by the caller's `sessionID`: an event for a different session
 * (or a session.idle/error for another id) → null, so a shared per-directory
 * subscription never leaks another session's events into this turn.
 */
export function mapOpencodeEvent(evt: unknown, sessionID: string): AgentEvent | null {
	if (!evt || typeof evt !== 'object') return null;
	const e = evt as { type?: unknown; properties?: unknown };
	if (typeof e.type !== 'string') return null;
	const props = (e.properties ?? {}) as Record<string, unknown>;

	switch (e.type) {
		case 'message.part.updated': {
			const part = props.part as
				| {
						type?: string;
						sessionID?: string;
						text?: string;
						tool?: string;
						state?: { status?: string; input?: Record<string, unknown> };
				  }
				| undefined;
			if (!part || part.sessionID !== sessionID) return null;
			const delta = typeof props.delta === 'string' ? props.delta : undefined;

			if (part.type === 'text' || part.type === 'reasoning') {
				// prefer the streaming delta; fall back to the accumulated part text.
				const text = delta ?? (typeof part.text === 'string' ? part.text : '');
				return { type: 'thinking', text };
			}
			if (part.type === 'tool') {
				const status = part.state?.status;

				// REQ-010 S1: the terminal-tool reply path is retired. There is no longer any
				// hula_send_message / hula_skip_reply detection here — the agent replies
				// out-of-band by running `aichat send-message` (the loopback capability), so
				// every tool maps generically: running/pending → start, completed/error → end.
				let phase: 'start' | 'end';
				if (status === 'running' || status === 'pending') phase = 'start';
				else if (status === 'completed' || status === 'error') phase = 'end';
				else return null; // unknown tool status → ignore
				return { type: 'tool', name: part.tool ?? 'unknown', phase };
			}
			// step-start / step-finish / snapshot / patch / agent / file / ... → ignore
			return null;
		}

		case 'session.idle': {
			if (props.sessionID !== sessionID) return null;
			// session fills the real durationMs; here it is a placeholder.
			return { type: 'done', durationMs: 0 };
		}

		case 'session.error': {
			// sessionID may be absent on session.error; only filter it out when it is
			// present AND points at a different session.
			if (typeof props.sessionID === 'string' && props.sessionID !== sessionID) return null;
			return { type: 'error', message: stringifyError(props.error) };
		}

		default:
			return null;
	}
}

/** Best-effort stringify of an opencode error payload into a human-readable message. */
function stringifyError(error: unknown): string {
	if (error == null) return 'opencode session error';
	if (typeof error === 'string') return error;
	if (typeof error === 'object') {
		const obj = error as Record<string, unknown>;
		// opencode errors are { name, data:{ message? } }-ish; surface the most useful field.
		const data = obj.data as Record<string, unknown> | undefined;
		const message = (data?.message ?? obj.message) as unknown;
		if (typeof message === 'string' && message.length > 0) {
			return typeof obj.name === 'string' ? `${obj.name}: ${message}` : message;
		}
		if (typeof obj.name === 'string') return obj.name;
		try {
			return JSON.stringify(error);
		} catch {
			return 'opencode session error';
		}
	}
	return String(error);
}
