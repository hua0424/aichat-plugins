import { describe, expect, it, vi } from 'vitest';
import { MessageHandler } from './message.js';
import type { RunDriver } from '../agent/events.js';
import type { HulaApiClient } from '../api/hula-api.js';
import type { HulaWSClient } from '../server/hula-ws.js';

function fixture() {
	const catalog = { version: 'catalog-v1', framework: 'test', runtimeVersion: 'native-v1', capabilities: [] };
	const driver = { type: 'test', discoverCapabilities: vi.fn(async () => catalog), executeCapability: vi.fn(async () => ({ status: 'completed', text: 'models' })), createRun: vi.fn() };
	const api = { reportAgentCommandResult: vi.fn(async () => {}), signDownload: vi.fn() };
	const ws = { send: vi.fn() };
	const handler = new MessageHandler(ws as unknown as HulaWSClient, driver as unknown as RunDriver, '42', api as unknown as HulaApiClient,
		{ waitMs: 1, maxWaitMs: 1 }, () => {}, () => { throw new Error('No chat state should be touched'); }, '/work');
	return { handler, driver, api, ws, catalog };
}
const request = { requestId: 'request-1', roomId: 'room-1', aiclawUid: '42', operation: 'discover', context: { roomType: 2, counterpartUid: '9007199254740993', isOwner: false } };

describe('structured command conversation boundary', () => {
	it('rejects conflicts, forged identity and unsupported drivers without native submission', async () => {
		const { handler, driver, api } = fixture();
		handler.handle({ type: 'agentCommand', data: request });
		await vi.waitFor(() => expect(api.reportAgentCommandResult).toHaveBeenCalledOnce());
		handler.handle({ type: 'agentCommand', data: { ...request, roomId: 'other' } });
		handler.handle({ type: 'agentCommand', data: { ...request, requestId: 'forged', aiclawUid: '99' } });
		await vi.waitFor(() => expect(api.reportAgentCommandResult).toHaveBeenCalledTimes(3));
		expect(api.reportAgentCommandResult).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'request-1', roomId: 'other', error: 'request_id_conflict' }));
		expect(api.reportAgentCommandResult).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'forged', error: 'identity_mismatch' }));
		expect(driver.discoverCapabilities).toHaveBeenCalledOnce();
		delete (driver as Partial<typeof driver>).discoverCapabilities;
		handler.handle({ type: 'agentCommand', data: { ...request, requestId: 'unsupported' } });
		await vi.waitFor(() => expect(api.reportAgentCommandResult).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'unsupported', status: 'unsupported' })));
		expect(driver.createRun).not.toHaveBeenCalled();
	});
	it('excludes command feedback and autoReply before media resolution, accumulation or chat', async () => {
		const { handler, driver, api, ws } = fixture();
		for (const extra of [{ commandFeedback: 'request-1' }, { autoReply: true }]) {
			handler.handle({ type: 'receiveMessage', data: { fromUser: { uid: 'human' }, message: {
				id: JSON.stringify(extra), roomId: 'room-1', roomType: 2, type: 4, extra,
				body: { url: 'https://private/file', content: 'please execute', size: 1 },
			} } });
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(ws.send).toHaveBeenCalledTimes(2);
		expect(api.signDownload).not.toHaveBeenCalled();
		expect(driver.createRun).not.toHaveBeenCalled();
	});
	it('keeps native failures and late timeouts correlated, without cancelling chat runs', async () => {
		vi.useFakeTimers();
		try {
			const { handler, driver, api } = fixture();
			let complete!: (value: { status: string; text: string }) => void;
			driver.executeCapability.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
			handler.handle({ type: 'agentCommand', data: { ...request, operation: 'invoke', capabilityId: 'model.list', catalogVersion: 'v1' } });
			await vi.advanceTimersByTimeAsync(15001);
			expect(api.reportAgentCommandResult).toHaveBeenCalledWith({ requestId: 'request-1', roomId: 'room-1', status: 'unknown', error: 'native_timeout' });
			expect(driver.executeCapability.mock.calls[0][0].signal.aborted).toBe(true);
			complete({ status: 'completed', text: 'late result' });
			await vi.advanceTimersByTimeAsync(1);
			expect(api.reportAgentCommandResult).toHaveBeenCalledOnce();
			handler.handle({ type: 'agentCommand', data: { ...request, operation: 'invoke', capabilityId: 'model.list', catalogVersion: 'v1' } });
			await vi.advanceTimersByTimeAsync(1);
			expect(driver.executeCapability).toHaveBeenCalledOnce();
			expect(api.reportAgentCommandResult).toHaveBeenLastCalledWith({ requestId: 'request-1', roomId: 'room-1', status: 'unknown', error: 'native_timeout' });
			driver.executeCapability.mockRejectedValue(new Error('secret native credential'));
			handler.handle({ type: 'agentCommand', data: { ...request, requestId: 'request-2', operation: 'invoke', capabilityId: 'model.list', catalogVersion: 'v1' } });
			await vi.advanceTimersByTimeAsync(1);
			expect(api.reportAgentCommandResult).toHaveBeenCalledWith({ requestId: 'request-2', roomId: 'room-1', status: 'failed', error: 'native_request_failed' });
			expect(driver.createRun).not.toHaveBeenCalled();
		} finally { vi.useRealTimers(); }
	});
	it('routes by identity/workspace and correlates duplicate results without creating a chat run', async () => {
		const { handler, driver, api, catalog } = fixture();
		handler.handle({ type: 'agentCommand', data: request });
		handler.handle({ type: 'agentCommand', data: request });
		await vi.waitFor(() => expect(api.reportAgentCommandResult).toHaveBeenCalledTimes(2));
		expect(driver.discoverCapabilities).toHaveBeenCalledOnce();
		expect(driver.discoverCapabilities).toHaveBeenCalledWith(expect.objectContaining({ workspace: expect.stringMatching(/42[\\/]dm[\\/]9007199254740993$/) }));
		expect(api.reportAgentCommandResult).toHaveBeenCalledWith({ requestId: 'request-1', roomId: 'room-1', status: 'completed', catalog });
		expect(driver.createRun).not.toHaveBeenCalled();
	});
});
