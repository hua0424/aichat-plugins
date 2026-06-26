import { describe, it, expect, vi } from 'vitest';
import { MessageHandler } from '../handler/message.js';
import type { HulaWSClient } from '../server/hula-ws.js';
import type { AgentDriver, AgentSession, AgentEvent } from './events.js';
import { WSReqType } from '../stream/protocol.js';
import type { ReceivedMessage } from '../stream/protocol.js';

/**
 * REQ-008 #75 — Golden behavior lock.
 *
 * Snapshots the HuLa WS send sequence produced by the REAL MessageHandler for a
 * representative set of agent-turn "scripts". The snapshot is the behavior
 * contract: it is recorded against the CURRENT (pre-refactor) code via the
 * fakeAdapter callbacks seam, then must still match BYTE-FOR-BYTE after the
 * AgentDriver refactor when the same scripts are driven through the new
 * fakeDriver/AgentEvent path.
 *
 * Nondeterminism (durationMs) is normalized out of the snapshot and asserted
 * separately (typeof === 'number') so timing has tolerance.
 */

const SELF_UID = 999;

/** A normalized agent-turn event the script feeds into whichever seam is active. */
type ScriptEvent =
	| { kind: 'thinking'; text: string }
	| { kind: 'done'; durationMs: number }
	| { kind: 'error'; message: string };

interface Script {
	name: string;
	events: ScriptEvent[];
}

// REQ-010 S1: the terminal-event reply path is retired, so a turn's WS send sequence is now
// driven purely by thinking text + done/error. THINKING_END carries NO skipReason ever.
const SCRIPTS: Script[] = [
	{
		name: 'a) thinking + done → complete',
		events: [
			{ kind: 'thinking', text: 'reason-1' },
			{ kind: 'done', durationMs: 123 },
		],
	},
	{
		name: 'b) deltas + done only → complete, no skipReason',
		events: [
			{ kind: 'thinking', text: 'just thinking' },
			{ kind: 'done', durationMs: 77 },
		],
	},
	{
		name: 'c) error',
		events: [
			{ kind: 'thinking', text: 'partial-' },
			{ kind: 'thinking', text: 'work' },
			{ kind: 'error', message: 'boom' },
		],
	},
	{
		name: 'd) two thinking deltas concatenated',
		events: [
			{ kind: 'thinking', text: 'foo' },
			{ kind: 'thinking', text: 'bar' },
			{ kind: 'done', durationMs: 9 },
		],
	},
];

function fakeWs() {
	const sent: Array<{ type: number; data: unknown }> = [];
	const ws = {
		isConnected: true,
		send: vi.fn((type: number, data: unknown) => {
			sent.push({ type, data });
		}),
	} as unknown as HulaWSClient & { send: ReturnType<typeof vi.fn> };
	return { ws, sent };
}

function humanMessage(roomId: number, fromUid: number, content: string, msgId: number): ReceivedMessage {
	return {
		fromUser: { uid: fromUid, name: 'user', userType: 1 },
		message: { id: msgId, roomId, type: 1, roomType: 2, body: { content } },
	} as unknown as ReceivedMessage;
}

async function waitFor(cond: () => boolean, timeoutMs = 500): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
		await new Promise((r) => setTimeout(r, 5));
	}
}

/**
 * POST-REFACTOR SEAM: a fake AgentDriver whose send() returns a controllable
 * async stream. The test pushes the script's events as AgentEvents; the handler
 * consumes them via `for await` and produces the WS sends. The SCRIPTS, the
 * normalize(), and the recorded .snap are unchanged from the pre-refactor run —
 * the snapshot matching on this new path = behavior preserved.
 */
interface ChatCall {
	push: (ev: AgentEvent) => void;
	finish: () => void;
}

function fakeDriver() {
	const calls: ChatCall[] = [];
	const driver = {
		type: 'fake',
		connect: vi.fn().mockResolvedValue(undefined),
		disconnect: vi.fn().mockResolvedValue(undefined),
		openSession: vi.fn(async (): Promise<AgentSession> => {
			return {
				send(): AsyncIterable<AgentEvent> {
					const buffer: AgentEvent[] = [];
					let done = false;
					let resolveNext: (() => void) | null = null;
					const wake = () => {
						if (resolveNext) {
							const r = resolveNext;
							resolveNext = null;
							r();
						}
					};
					calls.push({
						push: (ev) => {
							if (done) return;
							buffer.push(ev);
							wake();
						},
						finish: () => {
							if (done) return;
							done = true;
							wake();
						},
					});
					return {
						async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
							while (true) {
								while (buffer.length > 0) yield buffer.shift()!;
								if (done) return;
								await new Promise<void>((resolve) => {
									resolveNext = resolve;
								});
							}
						},
					};
				},
				async close() {},
			};
		}),
	} as unknown as AgentDriver;
	return { driver, calls };
}

/** Map a ScriptEvent to its AgentEvent shape. */
function toAgentEvent(ev: ScriptEvent): AgentEvent {
	switch (ev.kind) {
		case 'thinking':
			return { type: 'thinking', text: ev.text };
		case 'done':
			return { type: 'done', durationMs: ev.durationMs };
		case 'error':
			return { type: 'error', message: ev.message };
	}
}

/** Feed a script's events through the fakeDriver stream, awaiting the handler drain. */
async function feedScript(call: ChatCall, events: ScriptEvent[]): Promise<void> {
	for (const ev of events) {
		call.push(toAgentEvent(ev));
		if (ev.kind === 'done' || ev.kind === 'error') call.finish();
	}
	// let the handler's async for-await fully drain + finalize
	await new Promise((r) => setImmediate(r));
}

/**
 * Normalize a captured WS send sequence for snapshotting: strip nondeterministic
 * durationMs from THINKING_END data (replaced by a constant), preserving every
 * other field byte-for-byte.
 */
function normalize(sent: Array<{ type: number; data: unknown }>): unknown {
	return sent.map((frame) => {
		const data = { ...(frame.data as Record<string, unknown>) };
		const typeName = WSReqType[frame.type] ?? String(frame.type);
		if (frame.type === WSReqType.THINKING_END && 'durationMs' in data) {
			data.durationMs = '<durationMs:number>';
		}
		// ACK carries Date.now(); normalize it out so the snapshot is deterministic.
		if (frame.type === WSReqType.ACK && 'timestamp' in data) {
			data.timestamp = '<timestamp:number>';
		}
		return { type: typeName, data };
	});
}

describe('REQ-008 #75 golden behavior (MessageHandler WS send sequence)', () => {
	for (let i = 0; i < SCRIPTS.length; i++) {
		const script = SCRIPTS[i];
		it(script.name, async () => {
			const { driver, calls } = fakeDriver();
			const { ws, sent } = fakeWs();
			const handler = new MessageHandler(ws, driver, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 });

			const roomId = 1;
			handler.handle({ type: 'receiveMessage', data: humanMessage(roomId, 100, 'hello', i + 1) } as never);
			await waitFor(() => calls.length >= 1);

			await feedScript(calls[0], script.events);

			// durationMs tolerance: where a THINKING_END carries durationMs it must be a number.
			for (const frame of sent) {
				if (frame.type === WSReqType.THINKING_END) {
					const d = (frame.data as Record<string, unknown>).durationMs;
					expect(typeof d).toBe('number');
				}
			}

			expect(normalize(sent)).toMatchSnapshot();
		});
	}
});
