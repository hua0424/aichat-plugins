import type { AgentEvent } from './events.js';

/**
 * REQ-008 #75 — the result of reducing a completed agent turn.
 *
 * REQ-010 S1: the terminal-event reply path is retired. The agent no longer
 * signals "sent"/"skipped" via a terminal AgentEvent — it replies out-of-band by
 * running `aichat send-message` (the capability endpoint), so a turn's THINKING
 * outcome is now just its concatenated thinking text + a complete/error status.
 */
export interface ThinkingOutcome {
	content: string;
	status: 'complete' | 'error';
	/** present for 'complete' (from the done event); absent for 'error' / no-terminator fallback. */
	durationMs?: number;
	/** present only for 'error'. */
	error?: string;
}

/**
 * PURE (no clock, no I/O). Reduce a *completed* agent event sequence
 * (one that ends in a done or error event) into a ThinkingOutcome.
 *
 *  - content = concatenation of every `thinking` event's text, in order.
 *  - `tool` events are ignored entirely.
 *  - error  → { content, status:'error', error } (no durationMs).
 *  - done   → { content, status:'complete', durationMs } (from the done event).
 *  - no terminator → { content, status:'complete' } (durationMs absent).
 */
export function reduceThinking(events: Iterable<AgentEvent>): ThinkingOutcome {
	let content = '';

	for (const ev of events) {
		switch (ev.type) {
			case 'thinking':
				content += ev.text;
				break;
			case 'tool':
				// tool events have no effect on the outcome
				break;
			case 'error':
				return { content, status: 'error', error: ev.message };
			case 'done':
				return { content, status: 'complete', durationMs: ev.durationMs };
		}
	}

	// Sequence did not terminate in done/error. Mirror the 'complete' finalize
	// with no done event present (durationMs absent) so callers never receive a
	// partial outcome; in practice the driver always emits done/error.
	return { content, status: 'complete' };
}
