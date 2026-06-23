import type { AgentEvent } from './events.js';

/**
 * REQ-008 #75 — the result of reducing a completed agent turn.
 *
 * Mirrors the ThinkingSession ledger + the onThinkingEnd/onError finalize logic
 * that lived inline in MessageHandler before the AgentDriver refactor.
 */
export interface ThinkingOutcome {
	content: string;
	status: 'complete' | 'error';
	/** present for 'complete' (from the done event); absent for 'error'. */
	durationMs?: number;
	/** present only for 'error'. */
	error?: string;
	/** present only when terminal resolves to a skip (explicit or fallback). */
	skipReason?: string;
}

/**
 * PURE (no clock, no I/O). Reduce a *completed* agent event sequence
 * (one that ends in a done or error event) into a ThinkingOutcome.
 *
 * Semantics are copied EXACTLY from the pre-refactor MessageHandler logic:
 *  - content = concatenation of every `thinking` event's text, in order.
 *  - terminal ledger, send-wins: a `sent` overrides any prior `skipped`; a
 *    `skipped` only takes effect while the ledger is not already `sent`.
 *  - `tool` events are ignored entirely.
 *  - error  → { content, status:'error', error } (no skipReason, no durationMs).
 *  - done   → status:'complete', durationMs from the done event, skipReason:
 *               sent    → undefined (omitted)
 *               skipped → the recorded reason
 *               none    → 'agent_no_terminal_tool' (fallback)
 */
export function reduceThinking(events: Iterable<AgentEvent>): ThinkingOutcome {
	let content = '';
	let ledger: 'sent' | 'skipped' | 'none' = 'none';
	let skipReason: string | undefined;

	for (const ev of events) {
		switch (ev.type) {
			case 'thinking':
				content += ev.text;
				break;
			case 'terminal':
				if (ev.action === 'sent') {
					ledger = 'sent';
					skipReason = undefined;
				} else {
					// skipped: only while not already sent (send-wins)
					if (ledger !== 'sent') {
						ledger = 'skipped';
						skipReason = ev.reason;
					}
				}
				break;
			case 'tool':
				// non-terminal tool events have no effect
				break;
			case 'error':
				return { content, status: 'error', error: ev.message };
			case 'done': {
				const outcome: ThinkingOutcome = {
					content,
					status: 'complete',
					durationMs: ev.durationMs,
				};
				if (ledger === 'skipped') {
					outcome.skipReason = skipReason;
				} else if (ledger === 'none') {
					outcome.skipReason = 'agent_no_terminal_tool';
				}
				// ledger === 'sent' → skipReason omitted
				return outcome;
			}
		}
	}

	// Sequence did not terminate in done/error. Mirror the 'complete' finalize
	// with no done event present (durationMs absent) so callers never receive a
	// partial outcome; in practice the driver always emits done/error.
	const outcome: ThinkingOutcome = { content, status: 'complete' };
	if (ledger === 'skipped') {
		outcome.skipReason = skipReason;
	} else if (ledger === 'none') {
		outcome.skipReason = 'agent_no_terminal_tool';
	}
	return outcome;
}
