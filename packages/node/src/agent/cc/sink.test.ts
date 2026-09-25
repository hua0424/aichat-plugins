import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CcBroker } from './broker.js';
import { InMemoryBindTokenStore } from '../bind-token-store.js';
import { CcSessionRegistry, buildCcBridgeSink } from './sink.js';
import type { AgentEvent } from '../events.js';

describe('REQ-011 S3 — channel dead-path stays unwired', () => {
	for (const rel of ['../../handler/message.ts', './sink.ts', './headless-driver.ts', '../../commands/start.ts']) {
		it(`${rel} has no live channelPush reference`, () => {
			const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8');
			expect(src).not.toContain('channelPush');
		});
	}
});

describe('CcSessionRegistry', () => {
	it('isolates same-room identities, rooms and run attempts; old and repeated cleanup do not remove replacements', () => {
		const reg = new CcSessionRegistry();
		const a: AgentEvent[] = [], b: AgentEvent[] = [], other: AgentEvent[] = [], next: AgentEvent[] = [];
		const oldCleanup = reg.register('A', 'room', 'run-old', (e) => a.push(e));
		reg.register('B', 'room', 'run-b', (e) => b.push(e));
		reg.register('A', 'other', 'run-other', (e) => other.push(e));
		const newCleanup = reg.register('A', 'room', 'run-new', (e) => next.push(e));
		oldCleanup(); oldCleanup();
		const tool = { type: 'tool', name: 'Bash', phase: 'end' } as const;
		reg.push('A', 'room', 'run-old', tool); // late old hook
		reg.push('A', 'room', 'run-new', tool);
		reg.push('B', 'room', 'run-b', tool);
		reg.push('A', 'other', 'run-other', tool);
		reg.push('B', 'other', 'run-b', tool); // unknown room
		expect(a).toEqual([]);
		expect(next).toEqual([tool]);
		expect(b).toEqual([tool]);
		expect(other).toEqual([tool]);
		newCleanup(); newCleanup();
		reg.push('A', 'room', 'run-new', tool);
		expect(next).toEqual([tool]);
		reg.push('B', 'room', 'run-b', tool);
		expect(b).toEqual([tool, tool]);
	});
});

describe('CcBroker → buildCcBridgeSink', () => {
	it('routes only matching token identity + room + run; a missing/late run never selects the active room', async () => {
		const reg = new CcSessionRegistry();
		const tokens = new InMemoryBindTokenStore();
		const broker = new CcBroker({ resolve: (token) => tokens.resolve(token), sink: buildCcBridgeSink(reg) });
		const a = tokens.mint('A', 'room'), b = tokens.mint('B', 'room');
		const gotA: AgentEvent[] = [], gotB: AgentEvent[] = [];
		const cleanupA = reg.register('A', 'room', 'run-a', (ev) => gotA.push(ev));
		reg.register('B', 'room', 'run-b', (ev) => gotB.push(ev));
		const hook = (authToken: string, runId?: string) => broker.handle({ authToken, runId, body: { hook_event_name: 'PostToolUse', tool_name: 'Bash' } });
		expect((await hook(a)).status).toBe(400);
		expect((await hook(a, 'run-old')).status).toBe(200);
		expect((await hook(a, 'run-a')).status).toBe(200);
		expect((await hook(b, 'run-b')).status).toBe(200);
		expect((await hook('garbage', 'run-a')).status).toBe(401);
		expect(gotA).toEqual([{ type: 'tool', name: 'Bash', phase: 'end' }]);
		expect(gotB).toEqual([{ type: 'tool', name: 'Bash', phase: 'end' }]);
		cleanupA();
		expect((await hook(a, 'run-a')).status).toBe(200);
		expect(gotA).toHaveLength(1);
		const stop = await broker.handle({ authToken: b, runId: 'run-b', body: { hook_event_name: 'Stop' } });
		expect(stop.status).toBe(200); // Stop never completes the session
		expect(gotB).toHaveLength(1);
	});

	it('ignores lifecycle and MessageDisplay even with no run, never sources thinking from hooks', async () => {
		const reg = new CcSessionRegistry();
		const push = vi.fn();
		reg.register('A', 'room', 'run', push);
		const broker = new CcBroker({ resolve: () => ({ aiclawUid: 'A', roomId: 'room' }), sink: buildCcBridgeSink(reg) });
		for (const event of ['UserPromptSubmit', 'SessionStart', 'MessageDisplay']) {
			expect((await broker.handle({ authToken: 'token', body: { hook_event_name: event } })).status).toBe(200);
		}
		expect(push).not.toHaveBeenCalled();
	});
});
