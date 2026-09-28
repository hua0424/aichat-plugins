import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore } from '../capability/conversations.js';
import { MessageHandler } from '../handler/message.js';
import type { HulaWSClient } from '../server/hula-ws.js';
import type { AgentEvent, RunDriver } from './events.js';
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

// REQ-029 (#29): selfUid/roomId/msgId are opaque strings; the golden snapshot reflects that.
const SELF_UID = '999';

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
		onThinkingStart: undefined as undefined | ((data: Record<string, unknown>) => void),
		send: vi.fn((type: number, data: Record<string, unknown>) => {
			sent.push({ type, data });
			if (type === WSReqType.THINKING_START) queueMicrotask(() => ws.onThinkingStart?.(data));
		}),
	} as unknown as HulaWSClient & { send: ReturnType<typeof vi.fn>; onThinkingStart?: (data: Record<string, unknown>) => void };
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
	const driver: RunDriver = {
		type: 'fake', features: { cancel: 'best-effort', reset: 'supported', promptUpdate: 'per-run' },
		connect: async () => {}, disconnect: async () => {},
		createRun: () => {
			const buffer: AgentEvent[] = [];
			let done = false;
			let resolveNext: (() => void) | null = null;
			const wake = () => { const resolve = resolveNext; resolveNext = null; resolve?.(); };
			calls.push({ push: (ev) => { if (!done) { buffer.push(ev); wake(); } },
				finish: () => { done = true; wake(); } });
			return { events: { async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
				while (true) {
					while (buffer.length) yield buffer.shift()!;
					if (done) return;
					await new Promise<void>((resolve) => { resolveNext = resolve; });
				}
			} }, cancel: async () => ({ status: 'unconfirmed', reason: 'fake cannot stop' }), dispose: async () => {} };
		},
	};
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
		delete data.clientRunId;
		if (frame.type === WSReqType.THINKING_END) data.thinkingId = undefined; // normalize transport receipt; WS outcome remains unchanged
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

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe('REQ-008 #75 golden behavior (MessageHandler WS send sequence)', () => {
	for (let i = 0; i < SCRIPTS.length; i++) {
		const script = SCRIPTS[i];
		it(script.name, async () => {
			const { driver, calls } = fakeDriver();
			const { ws, sent } = fakeWs();
			const home = mkdtempSync(join(tmpdir(), 'golden-run-'));
			homes.push(home);
			const store = new ConversationStore({ home, serverNamespace: 'test', activeUids: new Set([SELF_UID]) });
			const handler = new MessageHandler(ws, driver, SELF_UID, undefined, { waitMs: 10, maxWaitMs: 50 }, () => {}, () => store);
			ws.onThinkingStart = (data) => handler.handle({ type: 'thinkingStart', data: {
				fromUid: SELF_UID, roomId: '1', triggerMsgId: String(i + 1), thinkingId: `tid-${i + 1}`,
				clientRunId: data.clientRunId,
			} } as never);

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
