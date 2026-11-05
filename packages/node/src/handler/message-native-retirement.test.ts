import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationStore } from '../capability/conversations.js';
import { MessageHandler } from './message.js';
import type { AgentDriver, NativeTurnEvent } from '../agent/events.js';
import type { HulaWSClient } from '../server/hula-ws.js';
import type { HulaApiClient } from '../api/hula-api.js';
it('releases ordinary native lifecycles across rounds and ignores attached duplicate terminal after completion', async () => {
 const home = mkdtempSync(join(tmpdir(), 'native-retirement-'));
 const store = new ConversationStore({ home, serverNamespace: 'test', activeUids: new Set(['u']), activeProviders: new Map([['u', 'opencode']]) });
 let handler!: MessageHandler, turn = 0;
 const frames: { type: number; data: Record<string, unknown> }[] = [];
 const send = (type: number, data: Record<string, unknown>) => {
  frames.push({ type, data });
  if (type === 20) queueMicrotask(() => handler.handle({ type: 'thinkingStart', data: { ...data, fromUid: 'u', thinkingId: `thinking-${data.clientRunId}` } }));
  if (type === 22) queueMicrotask(() => handler.handle({ type: 'thinkingEnd', data: { ...data, fromUid: 'u' } }));
 };
 const report = vi.fn(async () => {});
 const driver: AgentDriver = { type: 'opencode', features: { cancel: 'unsupported', reset: 'supported', promptUpdate: 'per-run' }, connect: async () => {}, disconnect: async () => {},
  createRun: (input) => ({ cancel: async () => ({ status: 'unsupported' }), dispose: async () => {}, events: { async *[Symbol.asyncIterator]() {
   const id = String(++turn); input.onNativeBound!({ sessionId: 'native', inputId: id, parentId: id, messageId: `assistant-${id}` });
   yield { type: 'thinking' as const, text: 'large transcript'.repeat(1000) }; yield { type: 'done' as const, durationMs: 1 };
  } } }),
  executeCapability: async ({ execution: e }) => {
   const event: NativeTurnEvent = { eventId: 'late', conversationId: e!.conversation.id, generation: 1,
    nativeRef: { sessionId: 'native', inputId: '1', parentId: '1', messageId: 'assistant-1' }, requestIds: ['attached'], relation: 'attached', phase: 'completed' };
   const bound = await e!.bindTurn(event); expect(bound.thinkingId).toBe(frames.find((f) => f.type === 22)!.data.thinkingId);
   await e!.emit({ type: 'turn', turn: event }); await e!.emit({ type: 'turn', turn: event });
   return { status: 'completed', generation: '1', nativeRef: event.nativeRef };
  } };
 handler = new MessageHandler({ send, isConnected: true } as unknown as HulaWSClient, driver, 'u', { reportAgentCommandResult: report } as unknown as HulaApiClient,
  { waitMs: 1, maxWaitMs: 1 }, () => {}, () => store, home);
 try {
  for (const id of ['1', '2']) {
   handler.handle({ type: 'receiveMessage', data: { fromUser: { uid: 'owner', name: 'Owner', userType: 1 }, message: { id, roomId: 'room', type: 1, roomType: 2, body: { content: 'hello' } } } });
   await vi.waitFor(() => expect(frames.filter((f) => f.type === 22)).toHaveLength(Number(id)));
   await vi.waitFor(() => expect(store.pendingRuns()).toHaveLength(0));
  }
  handler.handle({ type: 'agentCommand', data: { requestId: 'attached', roomId: 'room', aiclawUid: 'u', operation: 'invoke', capabilityId: 'skill:probe', catalogVersion: 'v', parameters: {},
   context: { roomType: 2, counterpartUid: 'owner', isOwner: true, authorizationEpoch: 'epoch' } } });
  await vi.waitFor(() => expect(report).toHaveBeenCalled());
  expect(frames.filter((f) => f.type === 20)).toHaveLength(2);
  expect(frames.filter((f) => f.type === 22)).toHaveLength(2);
 } finally { handler.destroy(); rmSync(home, { recursive: true, force: true }); }
});
