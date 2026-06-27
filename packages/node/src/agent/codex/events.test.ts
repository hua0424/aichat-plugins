import { describe, it, expect } from 'vitest';
import { mapCodexEvent, mapCodexItem } from './events.js';

describe('mapCodexItem', () => {
	it('reasoning → thinking', () => {
		expect(mapCodexItem({ id: 'r1', type: 'reasoning', text: 'pondering' })).toEqual({ type: 'thinking', text: 'pondering' });
	});

	it('agent_message → thinking (model text is analysis, not the reply)', () => {
		expect(mapCodexItem({ id: 'm1', type: 'agent_message', text: 'here is my analysis' })).toEqual({
			type: 'thinking',
			text: 'here is my analysis',
		});
	});

	it('command_execution in_progress → tool start; completed/failed → tool end', () => {
		expect(mapCodexItem({ id: 'c1', type: 'command_execution', command: 'ls -la', status: 'in_progress', aggregated_output: '' })).toEqual({
			type: 'tool',
			name: 'ls',
			phase: 'start',
		});
		expect(mapCodexItem({ id: 'c1', type: 'command_execution', command: 'ls -la', status: 'completed', aggregated_output: '' })).toEqual({
			type: 'tool',
			name: 'ls',
			phase: 'end',
		});
		expect(mapCodexItem({ id: 'c1', type: 'command_execution', command: 'ls -la', status: 'failed', aggregated_output: '' })).toEqual({
			type: 'tool',
			name: 'ls',
			phase: 'end',
		});
	});

	it('command_execution with empty command → name "shell"', () => {
		expect(mapCodexItem({ id: 'c1', type: 'command_execution', command: '', status: 'in_progress', aggregated_output: '' })).toEqual({
			type: 'tool',
			name: 'shell',
			phase: 'start',
		});
	});

	it('error item → error', () => {
		expect(mapCodexItem({ id: 'e1', type: 'error', message: 'boom' })).toEqual({ type: 'error', message: 'boom' });
	});

	it('ignored item types → null', () => {
		expect(mapCodexItem({ id: 'f1', type: 'file_change', changes: [], status: 'completed' })).toBeNull();
		expect(mapCodexItem({ id: 'w1', type: 'web_search', query: 'q' })).toBeNull();
		expect(mapCodexItem({ id: 't1', type: 'todo_list', items: [] })).toBeNull();
		expect(mapCodexItem({ id: 'mcp1', type: 'mcp_tool_call', server: 's', tool: 't', arguments: {}, status: 'completed' })).toBeNull();
	});

	it('garbage → null', () => {
		expect(mapCodexItem(null)).toBeNull();
		expect(mapCodexItem({})).toBeNull();
		expect(mapCodexItem({ type: 123 })).toBeNull();
	});
});

describe('mapCodexEvent', () => {
	it('item.* unwraps the item', () => {
		expect(mapCodexEvent({ type: 'item.started', item: { id: 'r', type: 'reasoning', text: 'x' } })).toEqual({ type: 'thinking', text: 'x' });
		expect(mapCodexEvent({ type: 'item.completed', item: { id: 'c', type: 'command_execution', command: 'git status', status: 'completed', aggregated_output: '' } })).toEqual({
			type: 'tool',
			name: 'git',
			phase: 'end',
		});
	});

	it('turn.completed → done(durationMs:0 placeholder)', () => {
		expect(mapCodexEvent({ type: 'turn.completed', usage: { input_tokens: 1 } })).toEqual({ type: 'done', durationMs: 0 });
	});

	it('turn.failed → error', () => {
		expect(mapCodexEvent({ type: 'turn.failed', error: { message: 'turn boom' } })).toEqual({ type: 'error', message: 'turn boom' });
	});

	it('error event → error', () => {
		expect(mapCodexEvent({ type: 'error', message: 'fatal' })).toEqual({ type: 'error', message: 'fatal' });
	});

	it('thread.started / turn.started → null (not AgentEvents)', () => {
		expect(mapCodexEvent({ type: 'thread.started', thread_id: 'abc' })).toBeNull();
		expect(mapCodexEvent({ type: 'turn.started' })).toBeNull();
	});

	it('garbage → null', () => {
		expect(mapCodexEvent(null)).toBeNull();
		expect(mapCodexEvent({ type: 999 })).toBeNull();
		expect(mapCodexEvent({ type: 'unknown.event' })).toBeNull();
	});
});
