import { describe, it, expect } from 'vitest';
import { reduceThinking } from './thinking-map.js';
import type { AgentEvent } from './events.js';

describe('reduceThinking (pure event reducer)', () => {
	it('sent: terminal sent + done → complete, no skipReason, durationMs from done', () => {
		const events: AgentEvent[] = [
			{ type: 'thinking', text: 'reasoning' },
			{ type: 'terminal', action: 'sent' },
			{ type: 'done', durationMs: 123 },
		];
		expect(reduceThinking(events)).toEqual({
			content: 'reasoning',
			status: 'complete',
			durationMs: 123,
		});
	});

	it('explicit skip (reason agent_skip_reply) → complete with that skipReason', () => {
		const events: AgentEvent[] = [
			{ type: 'thinking', text: 'analysing' },
			{ type: 'terminal', action: 'skipped', reason: 'agent_skip_reply' },
			{ type: 'done', durationMs: 50 },
		];
		expect(reduceThinking(events)).toEqual({
			content: 'analysing',
			status: 'complete',
			durationMs: 50,
			skipReason: 'agent_skip_reply',
		});
	});

	it('no-terminal → complete + fallback agent_no_terminal_tool', () => {
		const events: AgentEvent[] = [
			{ type: 'thinking', text: 'just thinking' },
			{ type: 'done', durationMs: 77 },
		];
		expect(reduceThinking(events)).toEqual({
			content: 'just thinking',
			status: 'complete',
			durationMs: 77,
			skipReason: 'agent_no_terminal_tool',
		});
	});

	it('error → status error, error message, content so far, NO skipReason, NO durationMs', () => {
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

	it('send-then-skip stays sent (send-wins) → no skipReason', () => {
		const events: AgentEvent[] = [
			{ type: 'thinking', text: 'x' },
			{ type: 'terminal', action: 'sent' },
			{ type: 'terminal', action: 'skipped', reason: 'agent_skip_reply' },
			{ type: 'done', durationMs: 200 },
		];
		const out = reduceThinking(events);
		expect(out.status).toBe('complete');
		expect(out).not.toHaveProperty('skipReason');
	});

	it('skip-then-send becomes sent (send-wins) → no skipReason', () => {
		const events: AgentEvent[] = [
			{ type: 'terminal', action: 'skipped', reason: 'agent_skip_reply' },
			{ type: 'terminal', action: 'sent' },
			{ type: 'done', durationMs: 10 },
		];
		const out = reduceThinking(events);
		expect(out.status).toBe('complete');
		expect(out).not.toHaveProperty('skipReason');
	});

	it('multiple thinking deltas concatenated in order', () => {
		const events: AgentEvent[] = [
			{ type: 'thinking', text: 'foo' },
			{ type: 'thinking', text: 'bar' },
			{ type: 'thinking', text: 'baz' },
			{ type: 'terminal', action: 'sent' },
			{ type: 'done', durationMs: 1 },
		];
		expect(reduceThinking(events).content).toBe('foobarbaz');
	});

	it('tool events are ignored entirely', () => {
		const events: AgentEvent[] = [
			{ type: 'tool', name: 'hula_find_friend', phase: 'start' },
			{ type: 'thinking', text: 'a' },
			{ type: 'tool', name: 'hula_find_friend', phase: 'end' },
			{ type: 'terminal', action: 'sent' },
			{ type: 'tool', name: 'command', phase: 'end' },
			{ type: 'done', durationMs: 5 },
		];
		expect(reduceThinking(events)).toEqual({
			content: 'a',
			status: 'complete',
			durationMs: 5,
		});
	});
});
