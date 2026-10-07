import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageHandler } from './message.js';
import { ConversationStore } from '../capability/conversations.js';
import { WSReqType } from '../stream/protocol.js';
import type { AgentEvent, RunDriver } from '../agent/events.js';
import type { HulaWSClient } from '../server/hula-ws.js';
import type { ReceivedMessage } from '../stream/protocol.js';
import { CcHeadlessDriver, type CcChild, type CcSpawnFn } from '../agent/cc/headless-driver.js';
import { CcSessionRegistry } from '../agent/cc/sink.js';

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
const message = (id: number): ReceivedMessage => ({
	fromUser: { uid: '7', name: 'user', userType: 1 },
	message: { id: String(id), roomId: '9', type: 1, roomType: 2, body: { content: `message ${id}` } },
}) as ReceivedMessage;

function setup() {
	const home = mkdtempSync(join(tmpdir(), 'handler-run-'));
	homes.push(home);
	const store = new ConversationStore({ home, serverNamespace: 'test', activeUids: new Set(['42']), activeProviders: new Map([['42', 'cc']]) });
	const sent: number[] = [];
	const frames: Array<{ type: number; data: Record<string, unknown> }> = [];
	const ws = { isConnected: true, send: vi.fn((type: number, data: Record<string, unknown>) => {
		if (type === WSReqType.THINKING_START) expect(store.pendingRuns()).toHaveLength(1);
		sent.push(type);
		frames.push({ type, data });
	}) } as unknown as HulaWSClient;
	let emit: ((event: AgentEvent) => void) | undefined;
	const cancel = vi.fn(async () => ({ status: 'unconfirmed' as const, reason: 'stop not proven' }));
	const createRun = vi.fn((_input: Parameters<RunDriver['createRun']>[0]) => ({
		events: { async *[Symbol.asyncIterator]() {
			const queue: AgentEvent[] = [];
			let wake: (() => void) | undefined;
			emit = (event) => { queue.push(event); wake?.(); };
			while (true) {
				if (queue.length) { const event = queue.shift()!; yield event; if (event.type === 'done' || event.type === 'error') return; }
				else await new Promise<void>((resolve) => { wake = resolve; });
			}
		} }, cancel, dispose: vi.fn(async () => {}),
	}));
	const driver: RunDriver = { type: 'cc', features: { cancel: 'best-effort', reset: 'supported', promptUpdate: 'per-run' },
		connect: async () => {}, disconnect: async () => {}, createRun };
	const handler = new MessageHandler(ws, driver, '42', undefined, { waitMs: 1, maxWaitMs: 1 }, () => {}, () => store);
	return { store, sent, frames, driver, createRun, cancel, handler, emit: (event: AgentEvent) => emit?.(event) };
}

describe('persisted MessageHandler run', () => {
	it('buffers fast END for its exact START receipt, retries the same run, ignores old receipts and rejections', async () => {
		const { handler, store, frames, emit } = setup();
		handler.handle({ type: 'receiveMessage', data: message(1) });
		await tick();
		const start = frames.find((f) => f.type === WSReqType.THINKING_START)!.data;
		const runId = start.clientRunId as string;
		expect(runId).toBe(store.pendingRuns()[0].runId);
		handler.handle({ type: 'thinkingEnd', data: { fromUid: '42', roomId: '9', status: 'error', error: 'thinking_start_unknown', clientRunId: runId } });
		expect(store.pendingRuns()[0].runId).toBe(runId); // Unknown transport result does not finalize/cancel the run.
		handler.onConnected();
		expect(frames.filter((f) => f.type === WSReqType.THINKING_START).map((f) => f.data.clientRunId)).toEqual([runId, runId]);
		emit({ type: 'done', durationMs: 1 });
		await tick();
		expect(frames.some((f) => f.type === WSReqType.THINKING_END)).toBe(false);
		handler.handle({ type: 'receiveMessage', data: message(2) });
		await tick();
		handler.handle({ type: 'thinkingStart', data: { fromUid: '42', roomId: '9', triggerMsgId: '1', thinkingId: 'bad', clientRunId: 'wrong' } });
		handler.handle({ type: 'thinkingEnd', data: { fromUid: '42', roomId: '9', status: 'error', error: 'rate_limit_exceeded', clientRunId: 'wrong' } });
		handler.handle({ type: 'thinkingRejected', data: { thinkingId: 'old-id', roomId: '9', clientRunId: runId, status: 'error', error: 'thinking_end_rejected' } });
		expect(store.pendingRuns()).toHaveLength(1); // END rejection is not a persisted terminal or room cancellation.
		expect(frames.some((f) => f.type === WSReqType.THINKING_END)).toBe(false);
		handler.handle({ type: 'thinkingStart', data: { fromUid: '42', roomId: '9', triggerMsgId: '1', thinkingId: 'tid-1', clientRunId: runId } });
		expect(frames.filter((f) => f.type === WSReqType.THINKING_END).map((f) => f.data)).toEqual([
			expect.objectContaining({ thinkingId: 'tid-1', clientRunId: runId, roomId: '9', status: 'complete' }),
		]);
		handler.onConnected();
		expect(frames.filter((f) => f.type === WSReqType.THINKING_END)).toHaveLength(2);
		handler.handle({ type: 'thinkingEnd', data: { fromUid: '42', roomId: '9', thinkingId: 'tid-1', clientRunId: runId, status: 'complete' } });
		handler.onConnected();
		expect(frames.filter((f) => f.type === WSReqType.THINKING_END)).toHaveLength(2);
		expect(store.pendingRuns()).toHaveLength(1); // Old terminal ACK must not close the next run.
		// A duplicate or stale receipt must never overwrite the next run's thinkingId.
		handler.handle({ type: 'thinkingStart', data: { fromUid: '42', roomId: '9', triggerMsgId: '1', thinkingId: 'tid-other', clientRunId: runId } });
		expect(frames.filter((f) => f.type === WSReqType.THINKING_END)).toHaveLength(2);
		handler.destroy();
		store.close();
	});
	it.each(['rate_limit_exceeded', 'thinking_members_unavailable'])(
		'a persisted %s END before START receipt cancels only its exact run', async (error) => {
			const { handler, store, frames, cancel } = setup();
			handler.handle({ type: 'receiveMessage', data: message(7) });
			await tick();
			const runId = frames.find((f) => f.type === WSReqType.THINKING_START)!.data.clientRunId;
			handler.handle({ type: 'thinkingEnd', data: { fromUid: '42', roomId: '9', thinkingId: 'limited', clientRunId: runId, status: 'error', error } });
			await tick();
			expect(cancel).toHaveBeenCalled();
			handler.onConnected();
			handler.handle({ type: 'thinkingStart', data: { fromUid: '42', roomId: '9', triggerMsgId: '7', clientRunId: runId, thinkingId: 'limited' } });
			expect(frames.filter((f) => f.type === WSReqType.THINKING_START)).toHaveLength(1);
			expect(frames.filter((f) => f.type === WSReqType.THINKING_END)).toHaveLength(0);
			handler.destroy();
			store.close();
		},
	);

	it('drops a buffered END if a persisted terminal arrives before its START receipt', async () => {
		const { handler, store, frames, emit } = setup();
		handler.handle({ type: 'receiveMessage', data: message(8) });
		await tick();
		const runId = frames.find((f) => f.type === WSReqType.THINKING_START)!.data.clientRunId;
		emit({ type: 'done', durationMs: 1 });
		await tick();
		handler.handle({ type: 'thinkingEnd', data: { fromUid: '42', roomId: '9', thinkingId: 'terminal', clientRunId: runId, status: 'error', error: 'thinking_members_unavailable' } });
		handler.handle({ type: 'thinkingStart', data: { fromUid: '42', roomId: '9', triggerMsgId: '8', clientRunId: runId, thinkingId: 'terminal' } });
		handler.onConnected();
		expect(frames.filter((f) => f.type === WSReqType.THINKING_END)).toHaveLength(0);
		expect(frames.filter((f) => f.type === WSReqType.THINKING_START)).toHaveLength(1);
		handler.destroy();
		store.close();
	});

	it('END rejection stops exact retry but cannot terminate the next run', async () => {
		const { handler, store, frames, emit } = setup();
		handler.handle({ type: 'receiveMessage', data: message(3) });
		await tick();
		const runId = frames.find((f) => f.type === WSReqType.THINKING_START)!.data.clientRunId;
		handler.handle({ type: 'thinkingStart', data: { fromUid: '42', roomId: '9', triggerMsgId: '3', clientRunId: runId, thinkingId: 'tid-3' } });
		emit({ type: 'done', durationMs: 2 });
		await tick();
		handler.handle({ type: 'receiveMessage', data: message(4) });
		await tick();
		handler.handle({ type: 'thinkingRejected', data: { thinkingId: 'tid-3', roomId: '9', clientRunId: runId, status: 'error', error: 'thinking_end_unknown' } });
		const beforeRetry = frames.filter((f) => f.type === WSReqType.THINKING_END).length;
		handler.onConnected();
		expect(frames.filter((f) => f.type === WSReqType.THINKING_END)).toHaveLength(beforeRetry + 1);
		handler.handle({ type: 'thinkingRejected', data: { thinkingId: 'tid-3', roomId: '9', clientRunId: runId, status: 'error', error: 'thinking_end_rejected' } });
		const endCount = frames.filter((f) => f.type === WSReqType.THINKING_END).length;
		handler.onConnected();
		expect(frames.filter((f) => f.type === WSReqType.THINKING_END)).toHaveLength(endCount);
		expect(store.pendingRuns()).toHaveLength(1);
		handler.destroy();
		store.close();
	});

	it('reset END is buffered with its original runId; unmatched START failure cannot stop a new run', async () => {
		const { handler, store, frames } = setup();
		handler.handle({ type: 'receiveMessage', data: message(10) });
		await tick();
		const runId = frames.find((f) => f.type === WSReqType.THINKING_START)!.data.clientRunId;
		store.reset('42', '9');
		await handler.cancelRun('9', runId as string);
		expect(frames.some((f) => f.type === WSReqType.THINKING_END)).toBe(false);
		handler.handle({ type: 'thinkingStart', data: { fromUid: '42', roomId: '9', triggerMsgId: '10', clientRunId: runId, thinkingId: 'old-id' } });
		expect(frames.find((f) => f.type === WSReqType.THINKING_END)!.data).toMatchObject({
			clientRunId: runId, thinkingId: 'old-id', roomId: '9', error: 'conversation_reset',
		});
		handler.destroy();
		store.close();
	});

	it('expires unanswered START and refuses late receipt without fabricating an END', async () => {
		vi.useFakeTimers();
		const { handler, store, frames } = setup();
		try {
			handler.handle({ type: 'receiveMessage', data: message(12) });
			await vi.advanceTimersByTimeAsync(2);
			const runId = frames.find((f) => f.type === WSReqType.THINKING_START)!.data.clientRunId;
			await vi.advanceTimersByTimeAsync(30_001);
			handler.handle({ type: 'thinkingStart', data: { fromUid: '42', roomId: '9', triggerMsgId: '12', clientRunId: runId, thinkingId: 'too-late' } });
			expect(frames.some((f) => f.type === WSReqType.THINKING_END)).toBe(false);
		} finally {
			handler.destroy();
			store.close();
			vi.useRealTimers();
		}
	});

	it('prepares Codex through the core without requesting a CC bind token', async () => {
		const home = mkdtempSync(join(tmpdir(), 'handler-codex-'));
		homes.push(home);
		const store = new ConversationStore({ home, serverNamespace: 'test', activeUids: new Set(['42']),
			activeProviders: new Map([['42', 'codex']]) });
		const received: string[] = [];
		const driver: RunDriver = {
			type: 'codex', features: { cancel: 'best-effort', reset: 'supported', promptUpdate: 'new-session' },
			connect: async () => {}, disconnect: async () => {},
			createRun(input) {
				input.conversation.assertCurrent();
				expect(input.bindToken).toBeUndefined();
				expect(input.workspace).toBe(join(home, '42', 'dm', '7'));
				received.push(input.message);
				return { events: { async *[Symbol.asyncIterator]() { yield { type: 'done' as const, durationMs: 1 }; } },
					cancel: async () => ({ status: 'stopped' as const }), dispose: async () => {} };
			},
		};
		const ws = { isConnected: true, send: vi.fn() } as unknown as HulaWSClient;
		const handler = new MessageHandler(ws, driver, '42', undefined, { waitMs: 1, maxWaitMs: 1 }, () => {}, () => store, home);
		handler.handle({ type: 'receiveMessage', data: message(501) } as never);
		for (let i = 0; i < 30 && !received.length; i++) await tick();
		expect(received).toEqual(['[HuLa 私聊]\n[user(7)]: message 501']);
		for (let i = 0; i < 30 && store.pendingRuns().length; i++) await tick();
		expect(store.pendingRuns()).toHaveLength(0);
		handler.destroy();
		store.close();
	});
	it('bridges a real CC driver to persistent run completion after native EOF', async () => {
		const home = mkdtempSync(join(tmpdir(), 'handler-cc-'));
		homes.push(home);
		const store = new ConversationStore({ home, serverNamespace: 'test', activeUids: new Set(['42']), activeProviders: new Map([['42', 'cc']]) });
		const stdoutData: Array<(data: string) => void> = [];
		const childClose: Array<(code: number | null, signal: string | null) => void> = [];
		const writes: string[] = [];
		const child: CcChild = {
			pid: 1251, stdin: { write: (text) => void writes.push(text), end: () => {} },
			stdout: { on: (event: string, cb: (...args: never[]) => void) => {
				if (event === 'data') stdoutData.push(cb as (data: string) => void);
			} } as CcChild['stdout'],
			stderr: { on: () => {} } as CcChild['stderr'],
			on: (event: string, cb: (...args: never[]) => void) => {
				if (event === 'close') childClose.push(cb as (code: number | null, signal: string | null) => void);
			}, kill: () => true,
		};
		let argv: readonly string[] = [];
		const spawn: CcSpawnFn = (_command, args) => { argv = args; return child; };
		const registry = new CcSessionRegistry();
		const driver = new CcHeadlessDriver({
			workspaceBase: home, brokerPort: 9100, registerHook: (key, run, push) => registry.registerContext(key, run, push),
			transcript: { append: () => {} }, spawn, platform: 'linux',
			kill: (_pid, signal) => { if (signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' }); },
			firstEventTimeoutMs: 1000, drainMs: 5, killGraceMs: 20,
		});
		const sent: number[] = [];
		let runId: string | undefined;
		const ws = { isConnected: true, send: (type: number, data: Record<string, unknown>) => {
			sent.push(type);
			if (type === WSReqType.THINKING_START) runId = data.clientRunId as string;
		} } as HulaWSClient;
		const handler = new MessageHandler(ws, driver, '42', undefined, { waitMs: 1, maxWaitMs: 1 }, () => {}, () => store, home);
		handler.setPromptTemplates({ identityAnchor: 'identity:{uid}', personaSection: 'persona:{persona}', replyContract: 'reply-contract:{reply_command}' });
		handler.handle({ type: 'receiveMessage', data: message(30) } as never);
		for (let i = 0; i < 30 && !writes.length; i++) await tick();
		expect(writes).toHaveLength(1);
		expect(JSON.parse(writes[0].trim()).message.content[0].text).toBe('[HuLa 私聊]\n[user(7)]: message 30');
		expect(argv.filter((arg) => arg === '--append-system-prompt')).toHaveLength(1);
		expect(argv[argv.indexOf('--append-system-prompt') + 1].match(/identity:42/g)).toHaveLength(1);
		expect(store.pendingRuns()).toHaveLength(1);
		handler.handle({ type: 'thinkingStart', data: { fromUid: '42', roomId: '9', triggerMsgId: '30', thinkingId: 'tid-30', clientRunId: runId } });
		stdoutData.forEach((data) => data('{"type":"result","is_error":false}\n'));
		childClose.forEach((close) => close(0, null));
		for (let i = 0; i < 30 && store.pendingRuns().length; i++) await tick();
		expect(store.pendingRuns()).toHaveLength(0);
		expect(sent).toContain(WSReqType.THINKING_END);
		handler.destroy();
		store.close();
	});
	it('holds the room and queue after reset when native cancel has no stop proof', async () => {
		const { handler, store, sent, createRun, cancel } = setup();
		handler.handle({ type: 'receiveMessage', data: message(1) } as never);
		await tick();
		expect(createRun).toHaveBeenCalledTimes(1);
		store.reset('42', '9');
		await handler.cancelRun('9');
		expect(cancel).toHaveBeenCalled();
		expect(store.get('42', '9')?.state).toBe('stop_unconfirmed');
		handler.handle({ type: 'receiveMessage', data: message(2) } as never);
		await tick();
		expect(createRun).toHaveBeenCalledTimes(1);
		expect(sent.filter((type) => type === WSReqType.THINKING_START)).toHaveLength(1);
		handler.destroy();
		await tick();
		store.close();
	});

	it('does not flush queued messages when upstream emits error without stop proof', async () => {
		const { handler, store, createRun, emit } = setup();
		handler.handle({ type: 'receiveMessage', data: message(20) } as never);
		await tick();
		handler.handle({ type: 'receiveMessage', data: message(21) } as never);
		emit({ type: 'error', message: 'upstream failed' });
		await tick();
		expect(createRun).toHaveBeenCalledTimes(1);
		expect(store.get('42', '9')?.state).toBe('stop_unconfirmed');
		expect(store.pendingRuns()).toHaveLength(1);
		handler.destroy();
		await tick();
		store.close();
	});

	it('releases a cleanly completed stream and drains queued room messages', async () => {
		const { handler, store, createRun, emit } = setup();
		handler.handle({ type: 'receiveMessage', data: message(10) } as never);
		await tick();
		handler.handle({ type: 'receiveMessage', data: message(11) } as never);
		emit({ type: 'done', durationMs: 1 });
		await tick();
		expect(createRun).toHaveBeenCalledTimes(2);
		expect(store.pendingRuns()).toHaveLength(1);
		const secondRunId = store.pendingRuns()[0].runId;
		await handler.cancelRun('9', 'old-reset-run');
		expect(store.pendingRuns()[0].runId).toBe(secondRunId);
		handler.destroy();
		await tick();
		store.close();
	});

	it('#343: queues behind a suspended CC conversation with ONE visible pause notice per episode', async () => {
		const home = mkdtempSync(join(tmpdir(), 'handler-suspend-')); homes.push(home);
		// #343 现场形状：sessionId 在场、原 cwd 从未持久化 → 挂起，消息排队但此前用户完全看不到原因。
		writeFileSync(join(home, 'conversations.json'), JSON.stringify({ version: 1, sources: {}, records: [{
			conversationId: 'c3430000-0000-4000-8000-000000000002', serverNamespace: 'test',
			identityId: '42', roomId: '9', adapterInstanceId: 'cc', generation: 1,
			contextKey: 'b'.repeat(64), state: 'suspended', nativeAliases: [{ provider: 'cc', id: 'd'.repeat(64) }],
			nativeState: { cc: { sessionId: 'old-cc' } },
		}] }));
		const store = new ConversationStore({ home, serverNamespace: 'test', activeUids: new Set(['42']),
			activeProviders: new Map([['42', 'cc']]) });
		expect(store.get('42', '9')?.state).toBe('suspended');
		const notices: Array<{ roomId: string; text: string }> = [];
		const api = { sendMessage: async (roomId: string, text: string) => { notices.push({ roomId, text }); return { msgId: 'n1' }; } };
		const createRun = vi.fn(() => ({
			events: { async *[Symbol.asyncIterator]() { yield { type: 'done' as const, durationMs: 1 }; } },
			cancel: async () => ({ status: 'stopped' as const }), dispose: async () => {},
		}));
		const driver: RunDriver = { type: 'cc', features: { cancel: 'best-effort', reset: 'supported', promptUpdate: 'per-run' },
			connect: async () => {}, disconnect: async () => {}, createRun };
		const ws = { isConnected: true, send: vi.fn() } as unknown as HulaWSClient;
		const handler = new MessageHandler(ws, driver, '42', api as never, { waitMs: 1, maxWaitMs: 1 }, () => {}, () => store);
		handler.handle({ type: 'receiveMessage', data: message(60) } as never);
		handler.handle({ type: 'receiveMessage', data: message(61) } as never);
		await tick();
		// 一个暂停回合只通告一次：原因 + 处理入口，不重复轰炸。
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({ roomId: '9' });
		expect(notices[0].text).toContain('已暂停');
		expect(notices[0].text).toContain('原工作目录');
		expect(notices[0].text).toContain('已排队');
		expect(createRun).not.toHaveBeenCalled();
		// owner reset 后房间恢复运行：排队消息随新一轮触发，且不再发暂停通告。
		store.reset('42', '9');
		handler.handle({ type: 'receiveMessage', data: message(62) } as never);
		for (let i = 0; i < 30 && !createRun.mock.calls.length; i++) await tick();
		expect(createRun).toHaveBeenCalled();
		expect(notices).toHaveLength(1);
		handler.destroy();
		await tick();
		store.close();
	});
});
