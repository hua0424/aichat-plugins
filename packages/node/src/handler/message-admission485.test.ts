import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageHandler } from './message.js';
import { ConversationStore } from '../capability/conversations.js';
import { WSReqType } from '../stream/protocol.js';
import type { AgentEvent, RunDriver } from '../agent/events.js';
import type { HulaWSClient } from '../server/hula-ws.js';
import type { ReceivedMessage } from '../stream/protocol.js';

/**
 * aichatoverview#485 (T4): server executes nothing it was not admitted to run.
 *
 * These are the client half of that contract:
 *  - the input's authorization generation is frozen when the input arrives and travels on START;
 *  - a definitive refusal never submits native work AND never auto-resumes — no debouncer
 *    re-drive, no requeue, no second attempt for the same input, even after the incident clears.
 *
 * "Native submit" is observable here because a driver's `createRun` only builds a run object:
 * the subprocess/requests start when the handler consumes `run.events`, which happens strictly
 * after the START-ready barrier passes. `submissions` counts exactly those consumptions.
 */

const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

const message = (id: number): ReceivedMessage =>
	({
		fromUser: { uid: '7', name: 'user', userType: 1 },
		message: { id: String(id), roomId: '9', type: 1, roomType: 2, body: { content: `message ${id}` } },
	}) as ReceivedMessage;

function setup() {
	const home = mkdtempSync(join(tmpdir(), 'handler-admission-'));
	homes.push(home);
	const store = new ConversationStore({
		home,
		serverNamespace: 'test',
		activeUids: new Set(['42']),
		activeProviders: new Map([['42', 'cc']]),
	});
	const frames: Array<{ type: number; data: Record<string, unknown> }> = [];
	const ws = {
		isConnected: true,
		send: vi.fn((type: number, data: Record<string, unknown>) => {
			frames.push({ type, data });
		}),
	} as unknown as HulaWSClient;
	// Counts real native submissions: the generator body runs only once consumed.
	let submissions = 0;
	const createRun = vi.fn((_input: Parameters<RunDriver['createRun']>[0]) => ({
		events: {
			async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
				submissions += 1;
				await new Promise<void>((resolve) => setTimeout(resolve, 5));
				yield { type: 'done', durationMs: 1 };
			},
		},
		cancel: async () => ({ status: 'stopped' as const }),
		dispose: async () => {},
	}));
	const driver: RunDriver = {
		type: 'cc',
		features: { cancel: 'best-effort', reset: 'supported', promptUpdate: 'per-run' },
		connect: async () => {},
		disconnect: async () => {},
		createRun,
	};
	const handler = new MessageHandler(ws, driver, '42', undefined, { waitMs: 1, maxWaitMs: 1 }, () => {}, () => store);
	return { handler, store, frames, createRun, submissions: () => submissions };
}

const startFrames = (frames: Array<{ type: number; data: Record<string, unknown> }>) =>
	frames.filter((f) => f.type === WSReqType.THINKING_START);

describe('#485 group run admission (client half)', () => {
	it('carries the input authorization generation on START', async () => {
		const { handler, store, frames } = setup();
		// @ts-expect-error private cache is the documented white-box injection point
		handler.groupConfigCache.set('42', '9', {
			rateLimitPerMinute: 0,
			mentionRequired: false,
			dailyLimit: 0,
			respondToAi: false,
			approved: true,
			authorizationEpoch: 'epoch-1',
		});
		handler.handle({ type: 'receiveMessage', data: message(1) });
		await tick();
		const start = startFrames(frames)[0];
		expect(start.data.authorizationEpoch).toBe('epoch-1');
		handler.destroy();
		store.close();
	});

	it('admits exactly once when the server echoes the exact START receipt', async () => {
		const { handler, store, frames, createRun, submissions } = setup();
		handler.handle({ type: 'receiveMessage', data: message(2) });
		await tick();
		const runId = startFrames(frames)[0].data.clientRunId as string;
		expect(createRun).toHaveBeenCalledTimes(1);
		expect(submissions()).toBe(0); // created, not submitted: the barrier has not passed
		handler.handle({
			type: 'thinkingStart',
			data: { fromUid: '42', roomId: '9', triggerMsgId: '2', thinkingId: 'tid-2', clientRunId: runId },
		});
		for (let i = 0; i < 30 && submissions() === 0; i++) await tick();
		expect(submissions()).toBe(1);
		for (let i = 0; i < 30 && store.pendingRuns().length; i++) await tick();
		expect(store.pendingRuns()).toHaveLength(0);
		handler.destroy();
		store.close();
	});

	it.each(['authorization_stale', 'authorization_not_approved', 'room_not_accessible'])(
		'a %s refusal submits nothing and never auto-resumes the same input',
		async (error) => {
			const { handler, store, frames, createRun, submissions } = setup();
			handler.handle({ type: 'receiveMessage', data: message(3) });
			await tick();
			const runId = startFrames(frames)[0].data.clientRunId as string;
			handler.handle({ type: 'thinkingEnd', data: { fromUid: '42', roomId: '9', status: 'error', error, clientRunId: runId } });
			// Let the barrier settle and give a (wrong) requeue every chance to fire.
			for (let i = 0; i < 15; i++) await tick();
			expect(submissions()).toBe(0); // no native submit, ever
			expect(createRun).toHaveBeenCalledTimes(1); // not re-created either
			expect(store.pendingRuns()).toHaveLength(0); // slot released, no phantom run
			expect(startFrames(frames)).toHaveLength(1); // no second attempt for this input
			// A later receipt cannot revive it: the run is gone and nothing is waiting on it.
			handler.handle({
				type: 'thinkingStart',
				data: { fromUid: '42', roomId: '9', triggerMsgId: '3', thinkingId: 'tid-3', clientRunId: runId },
			});
			for (let i = 0; i < 15; i++) await tick();
			expect(submissions()).toBe(0);
			expect(frames.filter((f) => f.type === WSReqType.THINKING_END)).toHaveLength(0);
			handler.destroy();
			store.close();
		},
	);

	it('keeps transport ambiguity re-drivable (a missing receipt is not a refusal)', async () => {
		const { handler, store, frames, createRun, submissions } = setup();
		handler.handle({ type: 'receiveMessage', data: message(4) });
		await tick();
		const runId = startFrames(frames)[0].data.clientRunId as string;
		handler.handle({ type: 'thinkingEnd', data: { fromUid: '42', roomId: '9', status: 'error', error: 'thinking_start_unknown', clientRunId: runId } });
		for (let i = 0; i < 10; i++) await tick();
		expect(submissions()).toBe(0);
		expect(store.pendingRuns()[0]?.runId).toBe(runId); // still the same bounded attempt
		// The real receipt can still arrive for the same run and let it through.
		handler.handle({
			type: 'thinkingStart',
			data: { fromUid: '42', roomId: '9', triggerMsgId: '4', thinkingId: 'tid-4', clientRunId: runId },
		});
		for (let i = 0; i < 30 && submissions() === 0; i++) await tick();
		expect(submissions()).toBe(1);
		expect(createRun).toHaveBeenCalledTimes(1);
		handler.destroy();
		store.close();
	});

	it('drops the input when a refusal wins the race against the START-ready barrier', async () => {
		// The refusal is delivered re-entrantly from inside ws.send, i.e. after the pending entry is
		// registered but before the barrier has a waiter: the exact window the parked-refusal path covers.
		const home = mkdtempSync(join(tmpdir(), 'handler-admission-race-'));
		homes.push(home);
		const store = new ConversationStore({
			home,
			serverNamespace: 'test',
			activeUids: new Set(['42']),
			activeProviders: new Map([['42', 'cc']]),
		});
		const frames: Array<{ type: number; data: Record<string, unknown> }> = [];
		let submissions = 0;
		let handler: MessageHandler | undefined;
		const ws = {
			isConnected: true,
			send: vi.fn((type: number, data: Record<string, unknown>) => {
				frames.push({ type, data });
				if (type === WSReqType.THINKING_START && data.clientRunId) {
					handler!.handle({
						type: 'thinkingEnd',
						data: {
							fromUid: '42',
							roomId: '9',
							status: 'error',
							error: 'authorization_stale',
							clientRunId: data.clientRunId,
						},
					});
				}
			}),
		} as unknown as HulaWSClient;
		const driver: RunDriver = {
			type: 'cc',
			features: { cancel: 'best-effort', reset: 'supported', promptUpdate: 'per-run' },
			connect: async () => {},
			disconnect: async () => {},
			createRun: vi.fn(() => ({
				events: {
					async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
						submissions += 1;
						yield { type: 'done', durationMs: 1 };
					},
				},
				cancel: async () => ({ status: 'stopped' as const }),
				dispose: async () => {},
			})),
		};
		handler = new MessageHandler(ws, driver, '42', undefined, { waitMs: 1, maxWaitMs: 1 }, () => {}, () => store);
		handler.handle({ type: 'receiveMessage', data: message(5) });
		for (let i = 0; i < 20; i++) await tick();
		expect(submissions).toBe(0); // never submitted: the refusal was read, not lost as ambiguity
		expect(store.pendingRuns()).toHaveLength(0); // slot released
		expect(startFrames(frames)).toHaveLength(1); // no requeue of the refused input
		handler.destroy();
		store.close();
	});
});
