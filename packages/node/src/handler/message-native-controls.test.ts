import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationStore } from '../capability/conversations.js';
import { MessageHandler } from './message.js';
import type { AgentDriver, AgentCapabilityInvocation, NativeTurnEvent } from '../agent/events.js';
import type { HulaWSClient } from '../server/hula-ws.js';
import type { HulaApiClient } from '../api/hula-api.js';
const dirs: string[] = [];
it('never turns an internal reconcileOnly request with missing journal into a native mutation', async () => {
 const home = mkdtempSync(join(tmpdir(), 'missing-control-')); dirs.push(home);
 const store = new ConversationStore({ home, serverNamespace: 'test', activeUids: new Set(['u']), activeProviders: new Map([['u', 'opencode']]) });
 const executeCapability = vi.fn(async () => ({ status: 'completed' as const })), report = vi.fn(async () => {});
 const handler = new MessageHandler({ send: vi.fn(), isConnected: true } as unknown as HulaWSClient, { type: 'opencode', executeCapability } as unknown as AgentDriver,
  'u', { reportAgentCommandResult: report } as unknown as HulaApiClient, undefined, () => {}, () => store, home);
 handler.handle({ type: 'agentCommand', data: { requestId: 'missing', roomId: 'room', aiclawUid: 'u', operation: 'invoke', capabilityId: 'skill:probe', catalogVersion: 'v', parameters: {}, reconcileOnly: true,
  context: { roomType: 2, counterpartUid: 'owner', isOwner: true, authorizationEpoch: 'epoch' } } });
 await vi.waitFor(() => expect(report).toHaveBeenCalledWith(expect.objectContaining({ status: 'unknown' })));
 expect(executeCapability).not.toHaveBeenCalled(); expect(store.get('u', 'room')).toBeUndefined();
 handler.destroy();
});
it.each([false, true])('reconciles a bound durable unknown with restart=%s and settles only its existing lifecycle', async (restart) => {
 const home = mkdtempSync(join(tmpdir(), 'restart-control-')); dirs.push(home);
 const options = { home, serverNamespace: 'test', activeUids: new Set(['u']), activeProviders: new Map([['u', 'opencode' as const]]) };
 const report = vi.fn(async () => {}), submitted = vi.fn();
 const request = { requestId: 'durable', roomId: 'room', aiclawUid: 'u', operation: 'invoke', capabilityId: 'skill:probe', catalogVersion: 'v', parameters: {}, context: { roomType: 2, counterpartUid: 'owner', isOwner: true, authorizationEpoch: 'epoch' } };
 const frames: { type: number; data: Record<string, unknown> }[] = [];
 const create = (store: ConversationStore, executeCapability: AgentDriver['executeCapability']) => {
  let handler!: MessageHandler;
  const send = (type: number, data: Record<string, unknown>) => { frames.push({ type, data });
   if (type === 20) queueMicrotask(() => handler.handle({ type: 'thinkingStart', data: { ...data, fromUid: 'u', thinkingId: 'durable-thinking' } })); };
  handler = new MessageHandler({ send, isConnected: true } as unknown as HulaWSClient,
   { type: 'opencode', executeCapability, createRun: vi.fn() } as unknown as AgentDriver, 'u', { reportAgentCommandResult: report } as unknown as HulaApiClient, undefined, () => {}, () => store, home);
  return handler;
 };
 const originalStore = new ConversationStore(options);
 const original = create(originalStore, async (input) => {
  if (input.recovery) return reads(input);
  const execution = input.execution;
  submitted(); await execution!.submitted({ sessionId: 'native', inputId: 'input' });
  await execution!.bindTurn({ eventId: 'bound', conversationId: execution!.conversation.id, generation: 1,
   nativeRef: { sessionId: 'native', inputId: 'input', messageId: 'intermediate', parentId: 'input' }, requestIds: ['durable'], relation: 'new', phase: 'bound' });
  return { status: 'unknown', generation: '1', nativeRef: { sessionId: 'native', inputId: 'input' } };
 });
 original.handle({ type: 'agentCommand', data: request });
 await vi.waitFor(() => expect(report).toHaveBeenCalledWith(expect.objectContaining({ status: 'unknown' })));
 expect(originalStore.get('u', 'room')?.pendingRuns).toHaveLength(1);
 report.mockClear(); // A crash does not run graceful destroy (which emits an intentional shutdown END).
 const reads = vi.fn(async (input: AgentCapabilityInvocation) => {
  expect(input.execution).toBeUndefined();
  expect(input.recovery).toMatchObject({ generation: 1, nativeRef: { sessionId: 'native', inputId: 'input' } });
  return { status: 'completed' as const, generation: '1', reconciled: true, nativeRef: { sessionId: 'native', inputId: 'input', messageId: 'assistant', parentId: 'input' } };
 });
 const restartedStore = restart ? new ConversationStore(options) : originalStore, restarted = restart ? create(restartedStore, reads) : original;
 restarted.handle({ type: 'agentCommand', data: request });
 await vi.waitFor(() => expect(report).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed', reconciled: true })));
 restarted.handle({ type: 'agentCommand', data: request });
 await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(2));
 expect(reads).toHaveBeenCalledOnce(); expect(submitted).toHaveBeenCalledOnce();
 expect(restartedStore.getControl('u', 'room', 'durable')?.receipt?.status).toBe('completed');
 expect(restartedStore.get('u', 'room')?.pendingRuns ?? []).toHaveLength(0);
 expect(frames.filter((f) => f.type === 20)).toHaveLength(1);
 expect(frames.filter((f) => f.type === 22)).toHaveLength(1);
 expect(frames.find((f) => f.type === 22)?.data).toMatchObject({ thinkingId: 'durable-thinking', status: 'complete' });
 restarted.handle({ type: 'agentCommand', data: { ...request, parameters: { arguments: 'changed' } } });
 await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(3));
 expect(reads).toHaveBeenCalledOnce(); expect(submitted).toHaveBeenCalledOnce();
 restarted.destroy();
});
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
it('attaches a second proven request to one native unit without duplicate START or END', async () => {
 const home = mkdtempSync(join(tmpdir(), 'attached-control-')); dirs.push(home);
 const store = new ConversationStore({ home, serverNamespace: 'test', activeUids: new Set(['u']), activeProviders: new Map([['u', 'opencode']]) });
 let handler!: MessageHandler;
 const send = vi.fn((type: number, data: Record<string, unknown>) => { if (type === 20) queueMicrotask(() => handler.handle({ type: 'thinkingStart', data: { ...data, fromUid: 'u', thinkingId: 'shared-thinking' } })); });
 const report = vi.fn(async (_value: unknown) => {}), bindings: { runId: string; thinkingId: string }[] = [], events: NativeTurnEvent[] = [];
 let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
 const executeCapability = vi.fn(async ({ execution: e }: AgentCapabilityInvocation) => {
  await e!.submitted({ sessionId: 'native', inputId: 'shared-input' });
  const attached = e!.requestId === 'second';
  const turn: NativeTurnEvent = { eventId: e!.requestId, conversationId: e!.conversation.id, generation: 1,
   nativeRef: { sessionId: 'native', inputId: 'shared-input', messageId: 'shared-assistant', parentId: 'shared-input' },
   requestIds: attached ? ['first', 'second'] : ['first'], relation: attached ? 'attached' : 'new', phase: 'bound' };
  events.push(turn); bindings.push(await e!.bindTurn(turn));
  if (attached) release(); else await gate;
  await e!.emit({ type: 'turn', turn: { ...turn, phase: 'completed' } });
  return { status: 'completed' as const, generation: '1', nativeRef: turn.nativeRef };
 });
 handler = new MessageHandler({ send, isConnected: true } as unknown as HulaWSClient, { type: 'opencode', executeCapability } as unknown as AgentDriver,
  'u', { reportAgentCommandResult: report } as unknown as HulaApiClient, undefined, () => {}, () => store, home);
 const request = { requestId: 'first', roomId: 'room', aiclawUid: 'u', operation: 'invoke', capabilityId: 'skill:probe', catalogVersion: 'v', parameters: {},
  context: { roomType: 2, counterpartUid: 'owner', isOwner: true, authorizationEpoch: 'epoch' } };
 handler.handle({ type: 'agentCommand', data: request });
 await vi.waitFor(() => expect(bindings).toHaveLength(1));
 handler.handle({ type: 'agentCommand', data: { ...request, requestId: 'second' } });
 await vi.waitFor(() => expect(new Set(report.mock.calls.map(([value]) => (value as { requestId: string }).requestId))).toEqual(new Set(['first', 'second'])));
 expect(bindings[1]).toEqual(bindings[0]);
 expect(events[1]).toMatchObject({ relation: 'attached', requestIds: ['first', 'second'] });
 expect(send.mock.calls.filter(([type]) => type === 20)).toHaveLength(1);
 expect(send.mock.calls.filter(([type]) => type === 22)).toHaveLength(1);
 expect(store.get('u', 'room')?.pendingRuns ?? []).toHaveLength(0);
 handler.destroy();
});
it('prepares a native control while occupied, binds only proven native turn, and settles exact START/END', async () => {
 const home = mkdtempSync(join(tmpdir(), 'message-native-')); dirs.push(home);
 const store = new ConversationStore({ home, serverNamespace: 'test', activeUids: new Set(['u']), activeProviders: new Map([['u', 'opencode']]) });
 const old = store.beginRun('u', 'room', 'old');
 let handler!: MessageHandler;
 const send = vi.fn((type: number, data: Record<string, unknown>) => {
  if (type === 20) queueMicrotask(() => handler.handle({ type: 'thinkingStart', data: { ...data, fromUid: 'u', thinkingId: `thinking-${data.clientRunId}` } }));
 });
 const report = vi.fn(async () => {});
 const api = { reportAgentCommandResult: report, getMemberInfo: async () => ({ name: 'Bot' }) };
 const executeCapability = vi.fn(async (input: AgentCapabilityInvocation) => {
  const e = input.execution!;
  expect(e.systemPrompt).toContain('aichat send-message');
  expect(e.authorizationEpoch).toBe('epoch');
  await e.submitted({ sessionId: 'native', inputId: 'user' });
  await e.emit({ type: 'receipt', receipt: { status: 'accepted', phase: 'accepted', generation: '1', nativeRef: { sessionId: 'native', inputId: 'user' } } });
  const turn: NativeTurnEvent = { eventId: 'bound', conversationId: e.conversation.id, generation: 1, nativeRef: { sessionId: 'native', inputId: 'user', messageId: 'assistant', parentId: 'user' }, requestIds: ['request'], relation: 'new', phase: 'bound' };
  const binding = await e.bindTurn(turn);
  expect(binding.thinkingId).toBe(`thinking-${binding.runId}`);
  await e.emit({ type: 'turn', turn: { ...turn, eventId: 'reasoning', event: { type: 'thinking', text: 'native thought' } } });
  await e.emit({ type: 'turn', turn: { ...turn, eventId: 'tool', event: { type: 'tool', name: 'bash', phase: 'end' } } });
  await e.emit({ type: 'turn', turn: { ...turn, eventId: 'done', phase: 'completed' } });
  return { status: 'completed' as const, generation: '1', nativeRef: turn.nativeRef };
 });
 const driver = { type: 'opencode', executeCapability, createRun: vi.fn() } as unknown as AgentDriver;
 handler = new MessageHandler({ send, isConnected: true } as unknown as HulaWSClient, driver, 'u', api as unknown as HulaApiClient, undefined, () => {}, () => store, home, undefined, 100);
 handler.setPromptTemplates({ replyContract: '{reply_command}', personaSection: '{persona}', identityAnchor: '{uid}' });
 const request = { requestId: 'request', roomId: 'room', aiclawUid: 'u', operation: 'invoke', capabilityId: 'skill:probe', catalogVersion: 'v', parameters: {}, context: { roomType: 2, counterpartUid: 'owner', isOwner: true, authorizationEpoch: 'epoch' } };
 handler.handle({ type: 'agentCommand', data: request });
 await vi.waitFor(() => expect(report).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' })));
 expect(driver.createRun).not.toHaveBeenCalled();
 expect(send.mock.calls.filter(([type]) => type === 20)).toHaveLength(1);
 expect(send.mock.calls.find(([type]) => type === 20)![1].triggerMsgId).toBeUndefined();
 expect(send.mock.calls.filter(([type]) => type === 22)).toHaveLength(1);
 expect(send.mock.calls.find(([type]) => type === 22)![1]).toMatchObject({ content: 'native thought' });
 expect(store.get('u', 'room')!.pendingRuns?.map((r) => r.runId)).toEqual(['old']);
 expect(() => old.assertCurrent()).not.toThrow();
 handler.handle({ type: 'agentCommand', data: request });
 await vi.waitFor(() => expect(report.mock.calls.length).toBeGreaterThan(2));
 expect(executeCapability).toHaveBeenCalledOnce();
 handler.destroy();
});
