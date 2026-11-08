import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageHandler } from './message.js';
import { ConversationStore } from '../capability/conversations.js';
import type { RunDriver } from '../agent/events.js';
import type { HulaApiClient } from '../api/hula-api.js';
import type { HulaWSClient } from '../server/hula-ws.js';

const UID = '42', ROOM = 'room-fence';

function command(requestId: string, expectedGeneration?: string, generationProbe?: boolean) {
	const probe = generationProbe === true;
	return {
		requestId, roomId: ROOM, aiclawUid: UID, operation: probe ? 'generation' : 'invoke',
		...(probe ? { generationProbe: true } : { capabilityId: 'skill:probe', parameters: { arguments: 'x' }, catalogVersion: 'v1' }),
		context: { roomType: 2 as const, counterpartUid: 'owner', isOwner: false, authorizationEpoch: 'epoch',
			...(expectedGeneration !== undefined ? { expectedGeneration } : {}) },
	};
}

async function fixture() {
	const home = mkdtempSync(join(tmpdir(), 'aichat-fence-'));
	const store = new ConversationStore({ home, serverNamespace: 'test', activeUids: new Set([UID]) });
	const executeCapability = vi.fn(async () => ({ status: 'completed' as const }));
	const driver = { type: 'test', executeCapability, createRun: vi.fn() };
	const api = { reportAgentCommandResult: vi.fn(async () => {}), signDownload: vi.fn() };
	const ws = { send: vi.fn() };
	const handler = new MessageHandler(ws as unknown as HulaWSClient, driver as unknown as RunDriver, UID,
		api as unknown as HulaApiClient, { waitMs: 1, maxWaitMs: 1 }, () => {}, () => store, '/work');
	const cleanup = () => rmSync(home, { recursive: true, force: true });
	return { handler, store, api, executeCapability, cleanup };
}

describe('approval generation fence on the real conversation store', () => {
	it('probe reports the authoritative local generation and never executes', async () => {
		const { handler, store, api, executeCapability, cleanup } = await fixture();
		try {
			handler.handle({ type: 'agentCommand', data: command('probe-a', undefined, true) });
			await vi.waitFor(() => expect(api.reportAgentCommandResult).toHaveBeenCalledWith(
				{ requestId: 'probe-a', roomId: ROOM, status: 'completed', phase: 'generation', generation: '0' }));
			expect(store.get(UID, ROOM)).toBeUndefined();
			store.getOrCreate(UID, ROOM);
			handler.handle({ type: 'agentCommand', data: command('probe-b', undefined, true) });
			await vi.waitFor(() => expect(api.reportAgentCommandResult).toHaveBeenCalledWith(
				{ requestId: 'probe-b', roomId: ROOM, status: 'completed', phase: 'generation', generation: '1' }));
			store.reset(UID, ROOM);
			handler.handle({ type: 'agentCommand', data: command('probe-c', undefined, true) });
			await vi.waitFor(() => expect(api.reportAgentCommandResult).toHaveBeenCalledWith(
				{ requestId: 'probe-c', roomId: ROOM, status: 'completed', phase: 'generation', generation: '2' }));
			expect(executeCapability).not.toHaveBeenCalled();
		} finally { cleanup(); }
	});

	it('accepts the initial snapshot, rejects a reset during the wait, and dispatches only the frozen numeric generation', async () => {
		const { handler, store, api, executeCapability, cleanup } = await fixture();
		const reports = () => api.reportAgentCommandResult.mock.calls.map(([result]: [any]) => result);
		try {
			// 首次合法审批：批准时本机还没有会话记录（可信 0），执行时 prepareControl 原子创建代次 1。
			handler.handle({ type: 'agentCommand', data: command('initial', '0') });
			await vi.waitFor(() => expect(reports().find((r) => r.requestId === 'initial')).toMatchObject({ status: 'completed' }));
			expect(store.get(UID, ROOM)?.generation).toBe(1);
			expect(executeCapability).toHaveBeenCalledOnce();
			// 等待期内真实 reset：冻结的 1 已过期，禁止执行，也禁止用 0 重猜。
			store.reset(UID, ROOM);
			expect(store.get(UID, ROOM)?.generation).toBe(2);
			handler.handle({ type: 'agentCommand', data: command('stale', '1') });
			await vi.waitFor(() => expect(reports().find((r) => r.requestId === 'stale'))
				.toMatchObject({ status: 'failed', error: 'authorization_changed' }));
			handler.handle({ type: 'agentCommand', data: command('blind-zero', '0') });
			await vi.waitFor(() => expect(reports().find((r) => r.requestId === 'blind-zero'))
				.toMatchObject({ status: 'failed', error: 'authorization_changed' }));
			expect(executeCapability).toHaveBeenCalledOnce();
			// 已知且稳定的数字代次正常下发。
			handler.handle({ type: 'agentCommand', data: command('stable', '2') });
			await vi.waitFor(() => expect(reports().find((r) => r.requestId === 'stable')).toMatchObject({ status: 'completed' }));
			expect(executeCapability).toHaveBeenCalledTimes(2);
		} finally { cleanup(); }
	});
});
