import { describe, it, expect } from 'vitest';
import { reduceThinking } from './thinking-map.js';
import type { AgentEvent } from './events.js';

describe('reduceThinking (pure event reducer)', () => {
	it('thinking + done → complete, content concatenated, durationMs from done', () => {
		const events: AgentEvent[] = [
			{ type: 'thinking', text: 'reasoning' },
			{ type: 'done', durationMs: 123 },
		];
		expect(reduceThinking(events)).toEqual({
			content: 'reasoning',
			status: 'complete',
			durationMs: 123,
		});
	});

	it('error → status error, error message, content so far, NO durationMs', () => {
		const events: AgentEvent[] = [
			{ type: 'thinking', text: 'partial-' },
			{ type: 'thinking', text: 'work' },
			{ type: 'error', message: 'boom' },
		];
		const out = reduceThinking(events);
		expect(out).toEqual({
			content: 'partial-work',
			status: 'error',
			error: 'boom',
		});
		expect(out).not.toHaveProperty('skipReason');
		expect(out).not.toHaveProperty('durationMs');
	});

	it('multiple thinking deltas concatenated in order', () => {
		const events: AgentEvent[] = [
			{ type: 'thinking', text: 'foo' },
			{ type: 'thinking', text: 'bar' },
			{ type: 'thinking', text: 'baz' },
			{ type: 'done', durationMs: 1 },
		];
		expect(reduceThinking(events).content).toBe('foobarbaz');
	});

	it('tool events are ignored entirely', () => {
		const events: AgentEvent[] = [
			{ type: 'tool', name: 'bash', phase: 'start' },
			{ type: 'thinking', text: 'a' },
			{ type: 'tool', name: 'bash', phase: 'end' },
			{ type: 'done', durationMs: 5 },
		];
		expect(reduceThinking(events)).toEqual({
			content: 'a',
			status: 'complete',
			durationMs: 5,
		});
	});

	it('no terminator fallback → complete with content, no durationMs', () => {
		const events: AgentEvent[] = [{ type: 'thinking', text: 'orphan' }];
		expect(reduceThinking(events)).toEqual({
			content: 'orphan',
			status: 'complete',
		});
	});

	// #120 NO-REGRESSION: the CC panel fix teed {thinking} events from stdout so this SHARED reducer (used
	// by all four drivers) builds the panel content. Prove the reducer still concatenates {thinking} into
	// content and ignores {tool} — the invariant openclaw/opencode/codex also rely on, unchanged by #120.
	it('#120 no-regression: concatenates {thinking} events into content and ignores {tool}', () => {
		const events: AgentEvent[] = [
			{ type: 'thinking', text: 'let me reason' },
			{ type: 'tool', name: 'Bash', phase: 'end' },
			{ type: 'thinking', text: ' then narrate' },
			{ type: 'done', durationMs: 7 },
		];
		expect(reduceThinking(events)).toEqual({
			content: 'let me reason then narrate',
			status: 'complete',
			durationMs: 7,
		});
	});
});
