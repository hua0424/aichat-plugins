import type { AgentEvent } from '../events.js';

/**
 * aichatoverview#421 — pure dsh-headless `--json` NDJSON line → driver mapping.
 *
 * Covers the dsh v0.2.0-rc.2 `--json` vocabulary (packages/bundle/headless/README.md
 * + json-stream.ts): `session` / `status` / `thinking` / `text` / `tool_call` /
 * `tool_result` / `final` / `error`. PURE: no clock, no I/O, one parsed line in →
 * one control outcome out. The run layer owns sequencing (final dedup, terminal
 * verdict from exit code + turn_end — never from the mere presence of an error line).
 *
 * Truncation (#423): every projected string/key is capped at 8 KiB and the line at
 * 32 KiB / depth 64, flagged `truncated: true` — except the terminal `final`, which
 * is deliberately exempt (lossless terminal contract). A truncated thinking/text
 * block is still streamed (marked) so the card keeps progressive content; the run
 * layer re-emits the full `final` text when it adds anything beyond the stream.
 */

/** `#423` incomplete-output marker appended to a truncated thinking/text block. */
export const TRUNCATED_MARKER = '…[truncated]';

/** Driver control outcome for one parsed `--json` line. */
export type MappedDshLine =
	| { kind: 'session'; sessionId: string; cwd?: string }
	| { kind: 'thinking'; text: string }
	| { kind: 'tool'; name: string; phase: 'start' | 'end'; callId?: string }
	| { kind: 'final'; text: string }
	| { kind: 'turn-end'; completed: boolean; detail?: string }
	| { kind: 'error-line'; message: string }
	| { kind: 'ignore' };

/** Extract a non-empty string field, else undefined. */
function pickText(obj: Record<string, unknown>, key: string): string | undefined {
	const v = obj[key];
	return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Map one parsed `--json` line. Unknown shapes, blank lines and non-turn status
 * phases → `{ kind: 'ignore' }`; an `error` line is stashed context only
 * ({ kind: 'error-line' }) — it never terminates the run by itself (#423).
 */
export function mapDshLine(line: unknown): MappedDshLine {
	if (!line || typeof line !== 'object') return { kind: 'ignore' };
	const obj = line as Record<string, unknown>;
	if (typeof obj.type !== 'string') return { kind: 'ignore' };
	const truncated = obj.truncated === true;

	switch (obj.type) {
		case 'session': {
			const sessionId = pickText(obj, 'sessionId');
			if (!sessionId) return { kind: 'ignore' };
			const cwd = pickText(obj, 'cwd');
			return cwd === undefined ? { kind: 'session', sessionId } : { kind: 'session', sessionId, cwd };
		}
		case 'thinking':
		case 'text': {
			// Committed per-step blocks, each emitted once (json-stream.ts) — stream
			// verbatim; a bounded (truncated) block is still shown, marked (#423).
			const raw = typeof obj.text === 'string' ? obj.text : '';
			if (raw === '') return { kind: 'ignore' };
			return { kind: 'thinking', text: truncated ? `${raw}${TRUNCATED_MARKER}` : raw };
		}
		case 'tool_call': {
			const name = pickText(obj, 'tool') ?? 'unknown';
			const callId = pickText(obj, 'callId');
			return callId === undefined
				? { kind: 'tool', name, phase: 'start' }
				: { kind: 'tool', name, phase: 'start', callId };
		}
		case 'tool_result': {
			// tool_result carries no tool name (callId/status/result only) — the run
			// layer pairs it back via the tool_call callId; unpairable ends stay
			// visible under 'unknown' (same fallback idiom as the opencode mapper).
			const name = pickText(obj, 'tool') ?? 'unknown';
			const callId = pickText(obj, 'callId');
			return callId === undefined
				? { kind: 'tool', name, phase: 'end' }
				: { kind: 'tool', name, phase: 'end', callId };
		}
		case 'final': {
			// Lossless terminal contract (exempt from the 8 KiB / 32 KiB / depth-64
			// bounds). Empty final carries no content — the run still ends via turn_end.
			const text = typeof obj.text === 'string' ? obj.text : '';
			return text === '' ? { kind: 'ignore' } : { kind: 'final', text };
		}
		case 'status': {
			if (obj.phase === 'turn_end') return mapTurnEnd(obj.reason);
			return { kind: 'ignore' };
		}
		case 'error': {
			const message = pickText(obj, 'message') ?? 'dsh error';
			return { kind: 'error-line', message };
		}
		default:
			return { kind: 'ignore' };
	}
}

/** turn_end reason → terminal polarity. Unknown shapes fail closed (not completed). */
function mapTurnEnd(reason: unknown): MappedDshLine {
	if (reason && typeof reason === 'object') {
		const r = reason as Record<string, unknown>;
		if (r.kind === 'completed') return { kind: 'turn-end', completed: true };
		if (r.kind === 'error') {
			const err = r.error as Record<string, unknown> | undefined;
			const code = err && typeof err.code === 'string' ? err.code : undefined;
			const message = err && typeof err.message === 'string' && err.message.length > 0 ? err.message : undefined;
			const detail = [code, message].filter((x) => x !== undefined).join(': ') || undefined;
			return detail === undefined
				? { kind: 'turn-end', completed: false }
				: { kind: 'turn-end', completed: false, detail };
		}
	}
	// A turn_end the runner wrote but we cannot prove completed is not a success claim (#423).
	return { kind: 'turn-end', completed: false, detail: 'dsh turn_end without a completed reason' };
}

/** Narrowed AgentEvent check for tests: thinking payload passthrough. */
export function toThinking(text: string): AgentEvent {
	return { type: 'thinking', text };
}
