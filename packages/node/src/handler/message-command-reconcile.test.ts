import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentCapabilityInvocation, AgentDriver, NativeTurnEvent } from '../agent/events.js';
import type { HulaApiClient } from '../api/hula-api.js';
import { ConversationStore } from '../capability/conversations.js';
import type { HulaWSClient } from '../server/hula-ws.js';
import { MessageHandler } from './message.js';

// #505: a cached terminal receipt is durable local evidence. Replaying it must
// carry reconciled:true so the server can repair a record that raced to unknown.
const dirs: string[] = [];
const handlers: MessageHandler[] = [];
afterEach(() => {
	for (const handler of handlers.splice(0)) handler.destroy();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Posted = Record<string, unknown>;
type ServerRecord = { status: string; reconciled?: boolean };

/** Source-derived model of AgentCommandService.complete() (46e82ee7:628-647). */
function applyServer(record: ServerRecord, callback: Posted): void {
	const status = String(callback.status);
	if ((callback.phase ?? 'outcome') === 'accepted') return;
	const uncertain = record.status === 'unknown';
	const reconcile = uncertain && callback.reconciled === true && ['completed', 'failed', 'noop'].includes(status);
	if (record.status !== 'accepted' && !reconcile) return;
	record.status = status;
	if (reconcile) record.reconciled = true;
}

const request = (requestId: string, extra: Record<string, unknown> = {}) => ({
	requestId, roomId: '20', aiclawUid: 'u', operation: 'invoke', capabilityId: 'skill:probe', catalogVersion: 'v',
	parameters: {}, context: { roomType: 2, counterpartUid: 'owner', isOwner: true, authorizationEpoch: 'epoch' }, ...extra,
});

function setup(store: ConversationStore, executeCapability: AgentDriver['executeCapability'], home: string, provider = 'opencode') {
	const posted: Posted[] = [];
	const notices: string[] = [];
	const api = { sendMessage: async (_room: string, body: string) => { notices.push(body); return { msgId: 'notice' }; },
		reportAgentCommandResult: vi.fn(async (value: Posted) => { posted.push({ ...value }); }),
		listSelfGroupConfigs: async () => [{ roomId: '20', authorizationEpoch: 'epoch', approved: 1 }],
	} as unknown as HulaApiClient;
	const driver = { type: provider, executeCapability } as unknown as AgentDriver;
	let handler!: MessageHandler;
	const send = vi.fn((type: number, data: Record<string, unknown>) => {
		if (type === 20) queueMicrotask(() => handler.handle({ type: 'thinkingStart', data: { ...data, fromUid: 'u', thinkingId: `thinking-${data.clientRunId}` } }));
	});
	handler = new MessageHandler({ send, isConnected: true } as unknown as HulaWSClient, driver, 'u', api, undefined, () => {}, () => store, home);
	handlers.push(handler);
	return { handler, posted, notices, send };
}

const complete = vi.fn(async ({ execution: e }: AgentCapabilityInvocation) => {
	await e!.submitted({ sessionId: 'native', inputId: 'input' });
	await e!.emit({ type: 'receipt', receipt: { status: 'accepted', phase: 'accepted', generation: '1', nativeRef: { sessionId: 'native', inputId: 'input' } } });
	const turn: NativeTurnEvent = { eventId: 'bound', conversationId: e!.conversation.id, generation: 1,
		nativeRef: { sessionId: 'native', inputId: 'input', messageId: 'assistant', parentId: 'input' }, requestIds: ['A'], relation: 'new', phase: 'bound' };
	await e!.bindTurn(turn);
	await e!.emit({ type: 'turn', turn: { ...turn, eventId: 'done', phase: 'completed' } });
	return { status: 'completed' as const, generation: '1', nativeRef: turn.nativeRef };
});

const waitForReports = async (posted: Posted[], count: number) => {
	await vi.waitFor(() => { if (posted.length < count) throw new Error('waiting for reports'); });
};

describe('command reconcile evidence', () => {
	it('reserves only the authorized original Claude session and fences competing input until closure', async () => {
		const home = mkdtempSync(join(tmpdir(), 'cc-compact-command-')); dirs.push(home);
		const sessionId = '350134b9-5bf9-49ab-b755-1868c400019b';
		const inputId = '94f1a809-4687-4f8f-8a80-0dc54fd7276c';
		const store = new ConversationStore({ home, serverNamespace: 'test', activeUids: new Set(['u']), activeProviders: new Map([['u', 'cc' as const]]) });
		store.getOrCreate('u', '20');
		store.registerNative('cc', sessionId, 'u', '20', { sessionId, workspace: home });
		let submitCompetingInput!: () => void;
		const execute = vi.fn(async ({ execution }: AgentCapabilityInvocation) => {
			const release = execution!.reserveCcCompact!(sessionId, inputId);
			expect(() => store.beginRun('u', '20', 'competing-input')).toThrow('CC_COMPACT_FENCED');
			expect(store.getControl('u', '20', execution!.requestId)).toMatchObject({
				state: 'submitted', ccCompactInputId: inputId, nativeRef: { sessionId },
			});
			submitCompetingInput();
			release();
			return { status: 'completed' as const, nativeRef: { sessionId }, effect: { kind: 'compact' as const, controlId: 'boundary', summaryId: 'summary', summary: true } };
		});
		const { handler, posted, notices, send } = setup(store, execute, home, 'cc');
		submitCompetingInput = () => handler.handle({ type: 'receiveMessage', data: {
			fromUser: { uid: 'owner', name: 'Owner', userType: 1 },
			message: { id: 'during-compact', roomId: '20', roomType: 2, type: 1, aiclaw: { isOwner: true }, body: { content: 'do not queue' } },
		} });
		await handler.prewarmGroupConfigs();
		const context = { roomType: 2, counterpartUid: 'owner', isOwner: true, expectedGeneration: '1' };
		handler.handle({ type: 'agentCommand', data: request('stale-compact', { capabilityId: 'session.compact', context: { ...context, authorizationEpoch: 'stale' } }) });
		await waitForReports(posted, 1);
		expect(posted[0]).toMatchObject({ status: 'failed', error: 'authorization_changed' });
		expect(execute).not.toHaveBeenCalled();
		handler.handle({ type: 'agentCommand', data: request('valid-compact', { capabilityId: 'session.compact', context: { ...context, authorizationEpoch: 'epoch' } }) });
		await vi.waitFor(() => expect(posted.find(value => value.requestId === 'valid-compact')).toMatchObject({ status: 'completed' }));
		expect(execute).toHaveBeenCalledOnce();
		expect(store.getControl('u', '20', 'valid-compact')).toMatchObject({ state: 'settled', ccCompactInputId: inputId });
		expect(store.getControl('u', '20', 'valid-compact')?.ccCompactFence).toBeUndefined();
		expect(notices).toEqual([expect.stringContaining('不会自动重试')]);
		expect(send.mock.calls.some(([type]) => type === 20)).toBe(false);
	});
	it.each([false, true])('does not publish a replacement receipt for a live native control (ACK=%s)', async (ack) => {
		const home = mkdtempSync(join(tmpdir(), 'c1diag-live-control-')); dirs.push(home);
		const store = new ConversationStore({ home, serverNamespace: 'test', activeUids: new Set(['u']), activeProviders: new Map([['u', 'opencode' as const]]) });
		let markSubmitted!: () => void;
		const submitted = new Promise<void>((resolve) => { markSubmitted = resolve; });
		let finish!: () => void;
		const nativeResult = new Promise<void>((resolve) => { finish = resolve; });
		const nativeRef = { sessionId: 'native' };
		const effect = { kind: 'compact' as const, controlId: 'boundary', summaryId: 'summary', summary: true };
		const execute = vi.fn(async ({ execution }: AgentCapabilityInvocation) => {
			if (!execution) return { status: 'unknown' as const, nativeRef };
			await execution.submitted(nativeRef);
			if (ack) await execution.emit({ type: 'receipt', receipt: { status: 'accepted', phase: 'accepted', generation: '1', nativeRef } });
			markSubmitted();
			await nativeResult;
			return { status: 'completed' as const, generation: '1', nativeRef, effect };
		});
		const { handler, posted } = setup(store, execute, home);
		const data = request('compact', { capabilityId: 'session.compact' });
		handler.handle({ type: 'agentCommand', data });
		await submitted;
		try {
			handler.handle({ type: 'agentCommand', data: { ...data, reconcileOnly: true } });
			// Drain both the WS handler continuation and immediate fixture recovery before releasing the original.
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(posted.map((value) => value.status)).toEqual(ack ? ['accepted'] : []);
			expect(store.getControl('u', '20', 'compact')?.receipt?.status).toBe(ack ? 'accepted' : undefined);
			expect(execute).toHaveBeenCalledOnce();
		} finally { finish(); }
		const originalReports = ack ? 3 : 2;
		await waitForReports(posted, originalReports);
		expect(posted.filter((value) => value.status === 'completed')).toHaveLength(2);
		const server: ServerRecord = { status: 'accepted' };
		for (const callback of posted) applyServer(server, callback);
		expect(server).toEqual({ status: 'completed' });
		expect(store.getControl('u', '20', 'compact')?.receipt?.status).toBe('completed');
		handler.handle({ type: 'agentCommand', data: { ...data, reconcileOnly: true } });
		await waitForReports(posted, originalReports + 1);
		expect(posted.at(-1)).toMatchObject({ requestId: 'compact', status: 'completed', generation: '1', nativeRef, effect, reconciled: true });
		expect(execute).toHaveBeenCalledOnce();
	});
	it('replays a cached completed receipt with reconciled:true so unknown can be repaired', async () => {
		const home = mkdtempSync(join(tmpdir(), 'c1diag-replay-')); dirs.push(home);
		const store = new ConversationStore({ home, serverNamespace: 'test', activeUids: new Set(['u']), activeProviders: new Map([['u', 'opencode' as const]]) });
		const execute = vi.fn(complete);
		const { handler, posted } = setup(store, execute, home);
		handler.handle({ type: 'agentCommand', data: request('A') });
		await waitForReports(posted, 2);
		const outcome = posted.find((value) => value.status === 'completed');
		expect(outcome).toMatchObject({ generation: '1' });
		expect(outcome).not.toHaveProperty('reconciled');
		expect(store.getControl('u', '20', 'A')?.receipt?.status).toBe('completed');

		const server: ServerRecord = { status: 'unknown' };
		applyServer(server, posted[0]);
		applyServer(server, outcome!);
		expect(server.status).toBe('unknown');

		handler.handle({ type: 'agentCommand', data: request('A', { reconcileOnly: true }) });
		await vi.waitFor(() => { if (!posted.some((value) => value.reconciled === true)) throw new Error('waiting for replayed evidence'); });
		const replay = posted.find((value) => value.reconciled === true)!;
		expect(replay).toMatchObject({ status: 'completed', generation: '1', reconciled: true });
		applyServer(server, replay);
		expect(server).toEqual({ status: 'completed', reconciled: true });
		expect(execute).toHaveBeenCalledOnce();
	});

	it('keeps the durable-unknown recovery path and its explicit evidence working', async () => {
		const home = mkdtempSync(join(tmpdir(), 'c1diag-recover-')); dirs.push(home);
		const store = new ConversationStore({ home, serverNamespace: 'test', activeUids: new Set(['u']), activeProviders: new Map([['u', 'opencode' as const]]) });
		const first = vi.fn(async ({ execution: e }: AgentCapabilityInvocation) => {
			await e!.submitted({ sessionId: 'native', inputId: 'input' });
			return { status: 'unknown' as const, generation: '1', nativeRef: { sessionId: 'native', inputId: 'input' } };
		});
		const recovery = vi.fn(async () => ({ status: 'completed' as const, generation: '1', reconciled: true,
			nativeRef: { sessionId: 'native', inputId: 'input', messageId: 'assistant', parentId: 'input' } }));
		const executeCapability = vi.fn(async (input: AgentCapabilityInvocation) => input.recovery ? recovery() : first(input));
		const { handler, posted } = setup(store, executeCapability, home);
		handler.handle({ type: 'agentCommand', data: request('B') });
		await waitForReports(posted, 1);
		expect(posted[0]).toMatchObject({ status: 'unknown' });

		handler.handle({ type: 'agentCommand', data: request('B', { reconcileOnly: true }) });
		await vi.waitFor(() => { if (!posted.some((value) => value.reconciled === true)) throw new Error('waiting for recovered evidence'); });
		const replay = posted.find((value) => value.reconciled === true);
		expect(replay).toMatchObject({ status: 'completed', reconciled: true });
		expect(recovery).toHaveBeenCalledOnce();
		expect(first).toHaveBeenCalledOnce();
	});

	it('does not replay terminal evidence for a mismatched request epoch', async () => {
		const home = mkdtempSync(join(tmpdir(), 'c1diag-epoch-')); dirs.push(home);
		const store = new ConversationStore({ home, serverNamespace: 'test', activeUids: new Set(['u']), activeProviders: new Map([['u', 'opencode' as const]]) });
		const execute = vi.fn(complete);
		const { handler, posted } = setup(store, execute, home);
		handler.handle({ type: 'agentCommand', data: request('E') });
		await vi.waitFor(() => { if (!posted.some((value) => value.status === 'completed')) throw new Error('waiting for live completion'); });
		handler.handle({ type: 'agentCommand', data: { ...request('E', { reconcileOnly: true }),
			context: { roomType: 2, counterpartUid: 'owner', isOwner: true, authorizationEpoch: 'other' } } });
		await vi.waitFor(() => { if (!posted.some((value) => value.error === 'native_request_failed')) throw new Error('waiting for mismatch rejection'); });
		const rejected = posted.find((value) => value.error === 'native_request_failed');
		expect(rejected).toMatchObject({ status: 'unknown', error: 'native_request_failed' });
		expect(posted.some((value) => value.reconciled === true)).toBe(false);
		expect(execute).toHaveBeenCalledOnce();
	});

	it('does not create or execute when the journal is missing', async () => {
		const home = mkdtempSync(join(tmpdir(), 'c1diag-missing-')); dirs.push(home);
		const store = new ConversationStore({ home, serverNamespace: 'test', activeUids: new Set(['u']), activeProviders: new Map([['u', 'opencode' as const]]) });
		const executeCapability = vi.fn(async () => ({ status: 'completed' as const }));
		const { handler, posted } = setup(store, executeCapability, home);
		handler.handle({ type: 'agentCommand', data: request('C', { reconcileOnly: true }) });
		await waitForReports(posted, 1);
		expect(posted[0]).toMatchObject({ status: 'unknown', error: 'native_request_failed' });
		expect(executeCapability).not.toHaveBeenCalled();
		expect(store.get('u', '20')).toBeUndefined();
	});

	it('replays a trusted terminal journal after a pure reset without touching the new generation', async () => {
		const home = mkdtempSync(join(tmpdir(), 'c1diag-reset-')); dirs.push(home);
		const store = new ConversationStore({ home, serverNamespace: 'test', activeUids: new Set(['u']), activeProviders: new Map([['u', 'opencode' as const]]) });
		store.getOrCreate('u', '20');
		const execute = vi.fn(complete);
		const { handler, posted } = setup(store, execute, home);
		const data = request('R', { context: { roomType: 2, counterpartUid: 'owner', isOwner: true, authorizationEpoch: 'epoch', expectedGeneration: '1' } });
		handler.handle({ type: 'agentCommand', data });
		await waitForReports(posted, 2);
		const server: ServerRecord = { status: 'unknown' };
		applyServer(server, posted[0]);
		applyServer(server, posted.find((value) => value.status === 'completed')!);
		expect(server.status).toBe('unknown');

		store.reset('u', '20');
		const reset = store.get('u', '20')!;
		expect(reset.generation).toBe(2);
		const nativeState = JSON.stringify(reset.nativeState);

		handler.handle({ type: 'agentCommand', data: { ...data, reconcileOnly: true } });
		await vi.waitFor(() => { if (!posted.some((value) => value.reconciled === true)) throw new Error('waiting for replayed terminal evidence'); });
		const replay = posted.find((value) => value.reconciled === true)!;
		expect(replay).toMatchObject({ status: 'completed', generation: '1', reconciled: true });
		applyServer(server, replay);
		expect(server).toEqual({ status: 'completed', reconciled: true });
		expect(execute).toHaveBeenCalledOnce();
		const after = store.get('u', '20')!;
		expect(after.generation).toBe(2);
		expect(JSON.stringify(after.nativeState)).toBe(nativeState);
	});

	it('keeps the execution fence for a pending old-generation journal', async () => {
		const home = mkdtempSync(join(tmpdir(), 'c1diag-pending-')); dirs.push(home);
		const store = new ConversationStore({ home, serverNamespace: 'test', activeUids: new Set(['u']), activeProviders: new Map([['u', 'opencode' as const]]) });
		store.getOrCreate('u', '20');
		const execute = vi.fn(() => new Promise<never>(() => {}));
		const { handler, posted } = setup(store, execute, home);
		const data = request('P', { context: { roomType: 2, counterpartUid: 'owner', isOwner: true, authorizationEpoch: 'epoch', expectedGeneration: '1' } });
		void handler.handle({ type: 'agentCommand', data });
		await vi.waitFor(() => { if (!store.getControl('u', '20', 'P')) throw new Error('waiting for journal'); });

		store.reset('u', '20');
		void handler.handle({ type: 'agentCommand', data: { ...data, reconcileOnly: true } });
		await vi.waitFor(() => { if (!posted.some((value) => value.status === 'failed' && value.error === 'authorization_changed')) throw new Error('waiting for execution-fence rejection'); });
		expect(posted.some((value) => value.reconciled === true)).toBe(false);
		expect(execute).toHaveBeenCalledOnce();
		expect(store.get('u', '20')!.generation).toBe(2);
	});
});
