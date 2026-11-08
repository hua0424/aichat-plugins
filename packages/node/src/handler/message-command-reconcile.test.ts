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
	if ((callback.phase ?? 'outcome') === 'accepted') {
		if (record.status !== 'unknown') record.status = 'accepted';
		return;
	}
	const uncertain = record.status === 'unknown';
	const reconcile = uncertain && callback.reconciled === true && ['completed', 'failed', 'noop'].includes(status);
	if (!reconcile) return;
	record.status = status;
	record.reconciled = true;
}

const request = (requestId: string, extra: Record<string, unknown> = {}) => ({
	requestId, roomId: '20', aiclawUid: 'u', operation: 'invoke', capabilityId: 'skill:probe', catalogVersion: 'v',
	parameters: {}, context: { roomType: 2, counterpartUid: 'owner', isOwner: true, authorizationEpoch: 'epoch' }, ...extra,
});

function setup(store: ConversationStore, executeCapability: AgentDriver['executeCapability'], home: string) {
	const posted: Posted[] = [];
	const api = { reportAgentCommandResult: vi.fn(async (value: Posted) => { posted.push({ ...value }); }) } as unknown as HulaApiClient;
	const driver = { type: 'opencode', executeCapability } as unknown as AgentDriver;
	let handler!: MessageHandler;
	const send = vi.fn((type: number, data: Record<string, unknown>) => {
		if (type === 20) queueMicrotask(() => handler.handle({ type: 'thinkingStart', data: { ...data, fromUid: 'u', thinkingId: `thinking-${data.clientRunId}` } }));
	});
	handler = new MessageHandler({ send, isConnected: true } as unknown as HulaWSClient, driver, 'u', api, undefined, () => {}, () => store, home);
	handlers.push(handler);
	return { handler, posted };
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
});
