import { describe, expect, it, vi } from 'vitest';
import { AgentCommandHandler } from './agent-command.js';
import type { AgentDriver, CapabilityExecution } from '../agent/events.js';
const request = { requestId: 'r', roomId: 'room', aiclawUid: 'u', operation: 'invoke', capabilityId: 'skill:probe', catalogVersion: 'v',
 parameters: { arguments: '  a\nhttps://a/<b>  ' }, context: { roomType: 2, counterpartUid: 'owner', isOwner: true, authorizationEpoch: 'epoch' } };
describe('command native execution seam', () => {
 it('does not deadline an acknowledged native command and reconciles unacknowledged unknown once without retransmission', async () => {
  vi.useFakeTimers();
  try {
   let finish!: (result: any) => void;
   let current: any;
   const emitted: any[] = [];
   const execution = { requestId: 'r', emit: async (e: any) => { emitted.push(e); if (e.type === 'receipt') current = e.receipt; } } as CapabilityExecution;
   const executeCapability = vi.fn((input) => new Promise<any>((resolve) => { finish = resolve; }));
   const handler = new AgentCommandHandler({ executeCapability } as unknown as AgentDriver, 'u', '/work', {
    prepare: async () => current ? { receipt: current } : { execution },
   });
   const waiting = handler.handle(request);
   await vi.advanceTimersByTimeAsync(15001);
   expect(await waiting).toMatchObject({ status: 'unknown' });
   expect(executeCapability.mock.calls[0][0].signal.aborted).toBe(false);
   finish({ status: 'completed', nativeRef: { sessionId: 's', inputId: 'u', parentId: 'u', messageId: 'a' }, generation: '1' });
   await vi.advanceTimersByTimeAsync(1);
   expect(emitted.at(-1)).toMatchObject({ receipt: { status: 'completed', reconciled: true } });
   expect(await handler.handle(request)).toMatchObject({ status: 'completed', reconciled: true });
   expect(executeCapability).toHaveBeenCalledOnce();
   current = undefined; emitted.length = 0;
   executeCapability.mockImplementation(async (input) => {
    await input.execution.emit({ type: 'receipt', receipt: { status: 'accepted', phase: 'accepted' } });
    return new Promise((resolve) => { finish = resolve; });
   });
   const long = handler.handle({ ...request, requestId: 'long' });
   await vi.advanceTimersByTimeAsync(60000);
   expect(emitted.some((e) => e.receipt?.status === 'unknown')).toBe(false);
   finish({ status: 'completed' });
   expect(await long).toMatchObject({ status: 'completed' });
  } finally { vi.useRealTimers(); }
 });
 it('preserves exact arguments, prepares trusted mutation without createRun, and reports native receipt', async () => {
  const emit = vi.fn(async () => {});
  const execution = { emit, requestId: 'r' } as unknown as CapabilityExecution;
  const prepare = vi.fn(async () => ({ execution }));
  const executeCapability = vi.fn(async (input) => { await input.execution.emit({ type: 'receipt', receipt: { status: 'accepted', phase: 'accepted' } }); return { status: 'completed' as const }; });
  const driver = { executeCapability, createRun: vi.fn() } as unknown as AgentDriver;
  const handler = new AgentCommandHandler(driver, 'u', '/work', { prepare });
  expect(await handler.handle(request)).toMatchObject({ status: 'completed' });
  expect(executeCapability.mock.calls[0][0].parameters).toEqual(request.parameters);
  expect(prepare).toHaveBeenCalledOnce();
  expect(driver.createRun).not.toHaveBeenCalled();
  expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'receipt', receipt: expect.objectContaining({ status: 'accepted' }) }));
  expect(await handler.handle({ ...request, parameters: { arguments: 'different' } })).toMatchObject({ error: 'request_id_conflict' });
 });
 it('reuses persisted receipt without native submission, rejects invalid parameters', async () => {
  const executeCapability = vi.fn();
  const handler = new AgentCommandHandler({ executeCapability } as unknown as AgentDriver, 'u', '/work', {
   prepare: async () => ({ receipt: { status: 'unknown', phase: 'outcome' } }),
  });
  expect(await handler.handle(request)).toMatchObject({ status: 'unknown' });
  expect(executeCapability).not.toHaveBeenCalled();
  expect(await handler.handle({ ...request, requestId: 'bad', parameters: { arguments: null } })).toMatchObject({ error: 'invalid_request' });
 });
 it('accepts only a decimal expectedGeneration and hands the frozen generation to preparation', async () => {
  const prepare = vi.fn(async () => ({ receipt: { status: 'failed' as const, error: 'authorization_changed' } }));
  const handler = new AgentCommandHandler({} as unknown as AgentDriver, 'u', '/work', { prepare });
  expect(await handler.handle({ ...request, context: { ...request.context, expectedGeneration: 'x' } }))
   .toMatchObject({ error: 'invalid_request' });
  expect(prepare).not.toHaveBeenCalled();
  const frozen = { ...request, requestId: 'frozen', context: { ...request.context, expectedGeneration: '7' } };
  expect(await handler.handle(frozen)).toMatchObject({ status: 'failed', error: 'authorization_changed' });
  expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ context: expect.objectContaining({ expectedGeneration: '7' }) }), expect.any(String));
  // 同一 requestId 换代次必须视为冲突，而不是复用旧指纹。
  expect(await handler.handle({ ...frozen, context: { ...frozen.context, expectedGeneration: '8' } }))
   .toMatchObject({ error: 'request_id_conflict' });
 });
});

describe('approval generation probe', () => {
 it('answers the probe without preparing, executing or entering the command cache', async () => {
  const prepare = vi.fn(async () => ({ receipt: { status: 'failed' as const, error: 'authorization_changed' } }));
  const executeCapability = vi.fn();
  const handler = new AgentCommandHandler({ executeCapability } as unknown as AgentDriver, 'u', '/work', { prepare, generation: () => 3 });
  expect(await handler.handle({ ...request, requestId: 'probe', operation: 'generation', generationProbe: true }))
   .toEqual({ requestId: 'probe', roomId: 'room', status: 'completed', phase: 'generation', generation: '3' });
  expect(prepare).not.toHaveBeenCalled();
  expect(executeCapability).not.toHaveBeenCalled();
  // 侦测响应不进命令缓存：同一 requestId 的正式下发仍走 prepare 并冻结代次。
  expect(await handler.handle({ ...request, requestId: 'probe', context: { ...request.context, expectedGeneration: '3' } }))
   .toMatchObject({ status: 'failed', error: 'authorization_changed' });
  expect(prepare).toHaveBeenCalledOnce();
  // 旧插件会把 operation=generation 当非法请求拒绝，因此侦测信封绝不会被当成真实 invoke 执行。
  expect(await handler.handle({ ...request, requestId: 'probe2', generationProbe: true }))
   .toMatchObject({ error: 'invalid_request' });
  const bare = new AgentCommandHandler({} as unknown as AgentDriver, 'u', '/work', { prepare });
  expect(await bare.handle({ ...request, requestId: 'probe3', operation: 'generation', generationProbe: true }))
   .toMatchObject({ error: 'execution_not_supported' });
 });
});
