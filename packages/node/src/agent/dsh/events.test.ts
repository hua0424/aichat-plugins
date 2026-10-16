import { describe, expect, it } from 'vitest';
import { mapDshLine, TRUNCATED_MARKER } from './events.js';

/** aichatoverview#421 — dsh `--json` line mapping shapes. */
describe('mapDshLine', () => {
	it('maps thinking and text blocks to thinking', () => {
		expect(mapDshLine({ type: 'thinking', text: 'reasoning…' })).toEqual({ kind: 'thinking', text: 'reasoning…' });
		expect(mapDshLine({ type: 'text', text: 'answer' })).toEqual({ kind: 'thinking', text: 'answer' });
	});

	it('marks truncated thinking/text blocks as incomplete (#423)', () => {
		expect(mapDshLine({ type: 'text', text: 'cut…', truncated: true })).toEqual({
			kind: 'thinking', text: `cut…${TRUNCATED_MARKER}`,
		});
		expect(mapDshLine({ type: 'thinking', text: 'r', truncated: true })?.kind).toBe('thinking');
	});

	it('maps tool_call/tool_result to tool start/end with callId pairing', () => {
		expect(mapDshLine({ type: 'tool_call', callId: 'c1', tool: 'bash', input: {} })).toEqual({
			kind: 'tool', name: 'bash', phase: 'start', callId: 'c1',
		});
		expect(mapDshLine({ type: 'tool_result', callId: 'c1', status: 'completed', result: 'ok' })).toEqual({
			kind: 'tool', name: 'unknown', phase: 'end', callId: 'c1',
		});
	});

	it('maps a lossless final verbatim (no bounds applied)', () => {
		const big = 'x'.repeat(100_000);
		const mapped = mapDshLine({ type: 'final', text: big });
		expect(mapped).toEqual({ kind: 'final', text: big });
	});

	it('treats error lines as stashed context, never terminal (#423)', () => {
		expect(mapDshLine({ type: 'error', message: 'boom' })).toEqual({ kind: 'error-line', message: 'boom' });
	});

	it('maps turn_end completed vs error reasons', () => {
		expect(mapDshLine({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } }))
			.toEqual({ kind: 'turn-end', completed: true });
		expect(mapDshLine({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'error', error: { code: 'E_X', message: 'm' } } }))
			.toEqual({ kind: 'turn-end', completed: false, detail: 'E_X: m' });
	});

	it('fails closed on unprovable turn_end and ignores non-turn status', () => {
		expect(mapDshLine({ type: 'status', phase: 'turn_end', turn: 1 })).toEqual({
			kind: 'turn-end', completed: false, detail: 'dsh turn_end without a completed reason',
		});
		expect(mapDshLine({ type: 'status', phase: 'step_end', turn: 1, step: 2 })).toEqual({ kind: 'ignore' });
		expect(mapDshLine({ type: 'session', sessionId: 'session-1', cwd: '/w' })).toEqual({
			kind: 'session', sessionId: 'session-1', cwd: '/w',
		});
	});

	it('ignores unknown shapes and empty text', () => {
		expect(mapDshLine(null)).toEqual({ kind: 'ignore' });
		expect(mapDshLine({ type: 'wat' })).toEqual({ kind: 'ignore' });
		expect(mapDshLine({ type: 'text', text: '' })).toEqual({ kind: 'ignore' });
		expect(mapDshLine({ type: 'final', text: '' })).toEqual({ kind: 'ignore' });
		expect(mapDshLine({ type: 'session' })).toEqual({ kind: 'ignore' });
	});
});
