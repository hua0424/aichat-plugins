import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { OpenclawDriver } from './openclaw-driver.js';
import { ConversationStore } from '../../capability/conversations.js';
import { MessageHandler } from '../../handler/message.js';
import type { HulaWSClient } from '../../server/hula-ws.js';
import type { HulaApiClient } from '../../api/hula-api.js';
import { WSReqType, type AgentCommandResponse } from '../../stream/protocol.js';

const waitFor = <T>(check: () => T | Promise<T>) => vi.waitFor(check, { timeout: 3000 });
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(options: { scopes?: string[]; version?: string; debounce?: { waitMs: number; maxWaitMs: number }; respondToAi?: boolean; signDownload?: () => Promise<{ url: string }> } = {}) {
 const home = await mkdtemp(join(tmpdir(), 'openclaw-reset-'));
 const openStore = () => new ConversationStore({ home, serverNamespace: 'server', activeUids: new Set(['1']), activeProviders: new Map([['1', 'openclaw']]) });
 let store = openStore();
 const token = store.contextKey('1', '2'), rawK = `${token}:aiclaw-1-room-2`, canonicalK = 'agent:native-a:' + rawK;
 store.registerNative('openclaw', token, '1', '2', { token, nativeRef: rawK });
 store.selectModel('1', '2', 1, { providerID: 'provider-b', modelID: 'model-b' });
 const native: { sessionId: string; resetPayload: unknown; onReset?: () => void | Promise<void>; onResolve?: () => void | Promise<void>; denied?: boolean } = {
  sessionId: 'native-session-old',
  resetPayload: { ok: true, key: canonicalK, entry: { sessionId: 'native-session-new' } },
 };
 class Socket extends EventEmitter {
  readonly sent: Array<{ id: string; method: string; params: Record<string, unknown> }> = [];
  send(data: string) {
   const frame = JSON.parse(data); this.sent.push(frame);
   queueMicrotask(async () => {
    let payload: unknown;
    if (frame.method === 'connect') payload = { type: 'hello-ok', protocol: 4, server: { version: options.version ?? '2026.6.5', connId: 'reset-connection' }, auth: { role: 'operator', scopes: options.scopes ?? ['operator.admin', 'operator.read'] } };
    if (frame.method === 'aichat.gatewayContext') payload = { schema: 1, healthy: false };
    if (frame.method === 'sessions.resolve') { await native.onResolve?.(); payload = { ok: true, key: canonicalK }; }
    if (frame.method === 'sessions.describe') payload = { session: { key: canonicalK, sessionId: native.sessionId } };
     if (frame.method === 'sessions.compact') payload = { ok: true, key: canonicalK, compacted: true };
    if (frame.method === 'sessions.reset') {
     await native.onReset?.();
     if (native.denied) { this.emit('message', Buffer.from(JSON.stringify({ type: 'res', id: frame.id, ok: false, error: { code: 'FORBIDDEN', message: 'native scope denied' } }))); return; }
     payload = native.resetPayload;
    }
    if (payload !== undefined) this.emit('message', Buffer.from(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload })));
   });
  }
  close() { this.emit('close', 1000, Buffer.from('test')); }
 }
 const sockets: Socket[] = [];
 const factory = () => { const socket = new Socket(); sockets.push(socket); queueMicrotask(() => { socket.emit('open'); socket.emit('message', Buffer.from(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'challenge' } }))); }); return socket as unknown as WebSocket; };
 const driver = new OpenclawDriver('ws://fake.invalid', '', factory, home, undefined, join(home, 'run-bind'));
 const receipts: AgentCommandResponse[] = [];
 const hula: { frames: Array<{ type: number; data: Record<string, unknown> }>; onSend?: (frame: { type: number; data: Record<string, unknown> }) => void } = { frames: [] };
 let currentEpoch = 'epoch';
 const notices: string[] = [];
 const handler = new MessageHandler({ send: (type: number, data: Record<string, unknown>) => { const frame = { type, data }; hula.frames.push(frame); hula.onSend?.(frame); }, isConnected: true } as unknown as HulaWSClient, driver, '1', { reportAgentCommandResult: async (receipt: AgentCommandResponse) => { receipts.push(receipt); }, sendMessage: async (_room: string, text: string) => { notices.push(text); return { msgId: 'notice' }; }, signDownload: options.signDownload, listSelfGroupConfigs: async () => [{ roomId: '2', approved: 1, authorizationEpoch: currentEpoch, respondToAi: options.respondToAi }] } as unknown as HulaApiClient, options.debounce ?? { waitMs: 1, maxWaitMs: 1 }, () => {}, () => store, home);
 cleanup.push(async () => { handler.destroy(); await driver.disconnect(); store.close(); await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
 await driver.connect(); await handler.prewarmGroupConfigs();
 const sendCommand = (requestId: string, patch: Record<string, unknown>) =>
  handler.handle({ type: 'agentCommand', data: { requestId, roomId: '2', aiclawUid: '1', operation: 'discover', context: { roomType: 2, counterpartUid: 'owner', isOwner: true, authorizationEpoch: currentEpoch }, ...patch } });
 const command = async (requestId: string, patch: Record<string, unknown> = {}) => {
  const start = receipts.length;
  sendCommand(requestId, patch);
  await waitFor(() => expect(receipts.slice(start).find(r => r.requestId === requestId)).toBeDefined());
  return receipts.slice(start).find(r => r.requestId === requestId)!;
 };
 return { get store() { return store; }, reopenStore: () => { store.close(); store = openStore(); }, driver, sockets, native, token, rawK, canonicalK, command, sendCommand, receipts, handler, hula, notices, setEpoch: async (epoch: string) => { currentEpoch = epoch; await handler.prewarmGroupConfigs(); } };
}

it('resets an idle core-bound K to a new native S without borrowing a directory R or losing the selected model', async () => {
 const f = await fixture(), before = f.store.get('1', '2')!;
 const catalog = (await f.command('discover-idle')).catalog!;
 expect(catalog.capabilities.find(capability => capability.id === 'session.reset')).toMatchObject({ supported: true, executable: true });
 const request = { operation: 'invoke', capabilityId: 'session.reset', catalogVersion: catalog.version };
 const receipt = await f.command('reset-idle', request);
 expect(receipt.status, JSON.stringify({ receipt, methods: f.sockets[0].sent.map(frame => frame.method) })).toBe('completed');
 expect(receipt.effect).toMatchObject({ kind: 'reset', sessionId: 'native-session-new', generation: '2' });
 expect(receipt.nativeRef).toEqual({ sessionId: f.rawK });
 expect(f.sockets[0].sent.filter(frame => frame.method === 'sessions.resolve').map(frame => frame.params)).toEqual([{ key: f.rawK }]);
 expect(f.sockets[0].sent.filter(frame => frame.method === 'sessions.reset').map(frame => frame.params)).toEqual([{ key: f.canonicalK, reason: 'reset' }]);
 const after = f.store.get('1', '2')!;
 expect(after.generation).toBe(before.generation + 1);
 expect(after.selectedModel).toEqual(before.selectedModel);
 expect(after.nativeState.openclaw).toMatchObject({ token: f.token, nativeRef: f.rawK, sessionId: 'native-session-new' });
 expect(after.pendingRuns ?? []).toHaveLength(0);
 expect(after.replyBindings ?? []).toHaveLength(0);
 expect((await f.command('reset-idle', { ...request, reconcileOnly: true })).status).toBe('completed');
 expect(f.sockets[0].sent.filter(frame => frame.method === 'sessions.reset')).toHaveLength(1);
});

it.each([
 { scopes: ['operator.read'] },
 { version: 'other-version' },
])('does not infer reset permission or compatibility from a connected gateway: %j', async options => {
 const f = await fixture(options), catalog = (await f.command('discover-denied')).catalog!;
 expect(catalog.capabilities.some(capability => capability.id === 'session.reset' && capability.executable)).toBe(false);
 expect(f.sockets[0].sent.some(frame => frame.method === 'sessions.reset')).toBe(false);
});

it('does not submit a new compact against a session rotated by an unconfirmed reset', async () => {
 const f = await fixture(), catalog = (await f.command('discover-before-unknown-reset')).catalog!;
 const reset = { operation: 'invoke', capabilityId: 'session.reset', catalogVersion: catalog.version };
 f.native.onReset = () => { f.native.sessionId = 'native-session-new'; };
 f.native.resetPayload = {}; // The Gateway changed S, but the reply cannot prove the effect.
 expect((await f.command('reset-unconfirmed', reset)).status).toBe('unknown');
 expect(f.store.get('1', '2')?.generation).toBe(1);
 expect((await f.command('reset-unconfirmed', { ...reset, reconcileOnly: true })).status).toBe('unknown');
 f.reopenStore(); // An unknown reply must not release the fence when the persisted journal is reloaded.
 f.handler.handle({ type: 'receiveMessage', data: {
  fromUser: { uid: '7', name: 'user', userType: 1 },
  message: { id: 'after-reset-ordinary', roomId: '2', type: 1, roomType: 2, body: { content: 'must not execute on the unconfirmed session' } },
 } });
 expect((await f.command('compact-after-unknown-reset', { ...reset, capabilityId: 'session.compact' })).status).toBe('failed');
 expect(f.notices).toEqual([expect.stringContaining('原生会话重置的结果尚未确认')]);
 expect(f.hula.frames.some(frame => frame.type === WSReqType.THINKING_START)).toBe(false);
 expect(f.sockets[0].sent.some(frame => frame.method === 'agent')).toBe(false);
 expect(f.sockets[0].sent.filter(frame => frame.method === 'sessions.reset')).toHaveLength(1);
 expect(f.sockets[0].sent.filter(frame => frame.method === 'sessions.compact')).toHaveLength(0);
});

it.each([
 {},
 { ok: true, key: 'wrong-key', entry: { sessionId: 'native-session-new' } },
 { ok: true, entry: { sessionId: 'native-session-new' } },
 'same-session',
 { ok: false },
])('keeps an unproven native effect unknown and never replays it: %j', async payload => {
 const f = await fixture(), catalog = (await f.command('discover-unproven')).catalog!;
 f.native.resetPayload = payload === 'same-session' ? { ok: true, key: f.canonicalK, entry: { sessionId: 'native-session-old' } } : payload;
 const request = { operation: 'invoke', capabilityId: 'session.reset', catalogVersion: catalog.version };
 expect((await f.command('reset-unproven', request)).status).toBe('unknown');
 expect(f.store.get('1', '2')!.generation).toBe(1);
 expect((await f.command('reset-unproven', { ...request, reconcileOnly: true })).status).toBe('unknown');
 expect(f.sockets[0].sent.filter(frame => frame.method === 'sessions.reset')).toHaveLength(1);
});

it('does not replace a core generation merely because native reset returned a new session', async () => {
 const f = await fixture(), catalog = (await f.command('discover-busy')).catalog!;
 f.store.beginRun('1', '2', 'unconfirmed-old-run', { authorizationEpoch: 'epoch' });
 expect((await f.command('reset-busy', { operation: 'invoke', capabilityId: 'session.reset', catalogVersion: catalog.version })).status).toBe('unknown');
 const after = f.store.get('1', '2')!;
 expect(after.generation).toBe(1);
 expect(after.state).toBe('stop_unconfirmed');
 expect(after.pendingRuns?.some(run => run.runId === 'unconfirmed-old-run')).toBe(true);
 expect(f.sockets[0].sent.filter(frame => frame.method === 'sessions.reset')).toHaveLength(1);
});

it('resets an accepted active run and ignores its late error while the new generation completes normally', async () => {
 const f = await fixture(), catalog = (await f.command('discover-active-reset')).catalog!;
 f.hula.onSend = frame => {
  if (frame.type === WSReqType.THINKING_START) {
   queueMicrotask(() => f.handler.handle({ type: 'thinkingStart', data: { fromUid: '1', roomId: '2', triggerMsgId: frame.data.triggerMsgId as string, thinkingId: `active-grant-${frame.data.triggerMsgId}`, clientRunId: frame.data.clientRunId as string } }));
  }
 };
 f.handler.handle({ type: 'receiveMessage', data: {
  fromUser: { uid: '7', name: 'user', userType: 1 },
  message: { id: 'active-old-input', roomId: '2', type: 1, roomType: 2, body: { content: 'ordinary input before active reset' } },
 } });
 await waitFor(() => expect(f.sockets[0].sent.filter(frame => frame.method === 'agent')).toHaveLength(1));
 const oldStart = f.hula.frames.find(frame => frame.type === WSReqType.THINKING_START)!.data;
 const oldRequest = f.sockets[0].sent.find(frame => frame.method === 'agent')!;
 const oldNativeRun = 'active-native-old', newNativeRun = 'active-native-new';
 f.sockets[0].emit('message', Buffer.from(JSON.stringify({ type: 'res', id: oldRequest.id, ok: true, payload: { status: 'accepted', runId: oldNativeRun } })));
 expect(f.store.pendingRuns()).toMatchObject([{ runId: oldStart.clientRunId, generation: 1 }]);
 expect(f.store.get('1', '2')!.replyBindings).toMatchObject([{ runId: oldStart.clientRunId, generation: 1, thinkingId: 'active-grant-active-old-input' }]);
 // Native reset, not an AIChat pre-abort, supplies the exact accepted old run's stop proof.
 f.native.onReset = () => {
  expect(f.store.pendingRuns()).toMatchObject([{ runId: oldStart.clientRunId, generation: 1 }]);
  f.sockets[0].emit('message', Buffer.from(JSON.stringify({ type: 'event', event: 'agent', payload: { runId: oldNativeRun, seq: 1, stream: 'lifecycle', ts: Date.now(), data: { phase: 'error', error: 'native reset stopped old run' } } })));
 };
 const reset = await f.command('reset-active-run', { operation: 'invoke', capabilityId: 'session.reset', catalogVersion: catalog.version });
 expect(reset.status).toBe('completed');
 expect(reset.effect).toMatchObject({ kind: 'reset', sessionId: 'native-session-new', generation: '2' });
 await waitFor(() => expect(f.store.pendingRuns()).toHaveLength(0));
 expect(f.store.get('1', '2')).toMatchObject({ generation: 2, state: 'ready', nativeState: { openclaw: { nativeRef: f.rawK, sessionId: 'native-session-new' } } });
 expect(f.sockets[0].sent.filter(frame => frame.method === 'sessions.reset').map(frame => frame.params)).toEqual([{ key: f.canonicalK, reason: 'reset' }]);
 // Reset alone neither starts ordinary work nor creates a reply grant for generation 2.
 expect(f.hula.frames.filter(frame => frame.type === WSReqType.THINKING_START)).toHaveLength(1);
 expect(f.sockets[0].sent.filter(frame => frame.method === 'agent')).toHaveLength(1);
 expect((f.store.get('1', '2')!.replyBindings ?? []).filter(binding => binding.generation === 2)).toHaveLength(0);
 f.handler.handle({ type: 'receiveMessage', data: {
  fromUser: { uid: '7', name: 'user', userType: 1 },
  message: { id: 'active-new-input', roomId: '2', type: 1, roomType: 2, body: { content: 'genuinely new ordinary input after active reset' } },
 } });
 await waitFor(() => expect(f.sockets[0].sent.filter(frame => frame.method === 'agent')).toHaveLength(2));
 const newStart = f.hula.frames.filter(frame => frame.type === WSReqType.THINKING_START)[1].data;
 const newRequest = f.sockets[0].sent.filter(frame => frame.method === 'agent')[1];
 expect(newStart.clientRunId).not.toBe(oldStart.clientRunId);
 expect(newRequest.params.message).toBe('[HuLa 私聊]\n[user(7)]: genuinely new ordinary input after active reset');
 expect(newRequest.params.sessionKey).toBe(oldRequest.params.sessionKey);
 f.sockets[0].emit('message', Buffer.from(JSON.stringify({ type: 'res', id: newRequest.id, ok: true, payload: { status: 'accepted', runId: newNativeRun } })));
 expect(f.store.pendingRuns()).toMatchObject([{ runId: newStart.clientRunId, generation: 2 }]);
 expect((f.store.get('1', '2')!.replyBindings ?? []).filter(binding => binding.generation === 2)).toMatchObject([{ runId: newStart.clientRunId, thinkingId: 'active-grant-active-new-input' }]);
 const activeSlot = f.store.pendingRuns();
 const newEnds = () => f.hula.frames.filter(frame => frame.type === WSReqType.THINKING_END && frame.data.clientRunId === newStart.clientRunId);
 f.sockets[0].emit('message', Buffer.from(JSON.stringify({ type: 'event', event: 'agent', payload: { runId: oldNativeRun, seq: 2, stream: 'lifecycle', ts: Date.now(), data: { phase: 'error', error: 'late old error must not settle the new run' } } })));
 await new Promise<void>(resolve => setImmediate(resolve));
 expect(f.store.pendingRuns()).toEqual(activeSlot);
 expect(f.store.get('1', '2')).toMatchObject({ generation: 2, state: 'ready' });
 expect(newEnds()).toHaveLength(0);
 f.sockets[0].emit('message', Buffer.from(JSON.stringify({ type: 'event', event: 'agent', payload: { runId: newNativeRun, seq: 1, stream: 'assistant', ts: Date.now(), data: { delta: 'new run remains generation 2' } } })));
 f.sockets[0].emit('message', Buffer.from(JSON.stringify({ type: 'event', event: 'agent', payload: { runId: newNativeRun, seq: 2, stream: 'lifecycle', ts: Date.now(), data: { phase: 'end' } } })));
 await waitFor(() => expect(f.store.pendingRuns()).toHaveLength(0));
 expect(newEnds().map(frame => frame.data)).toMatchObject([{ clientRunId: newStart.clientRunId, thinkingId: 'active-grant-active-new-input', status: 'complete', content: 'new run remains generation 2' }]);
 expect(f.store.get('1', '2')).toMatchObject({ generation: 2, state: 'ready' });
 expect(f.hula.frames.filter(frame => frame.type === WSReqType.THINKING_START)).toHaveLength(2);
 expect(f.sockets[0].sent.filter(frame => frame.method === 'agent')).toHaveLength(2);
 // Exhaustive request allowlist excludes any extra abort/pre-stop RPC around native reset.
 expect(f.sockets[0].sent.map(frame => frame.method)).toEqual(expect.arrayContaining(['agent', 'sessions.resolve', 'sessions.describe', 'sessions.reset']));
 expect(f.sockets[0].sent.filter(frame => !['connect', 'aichat.gatewayContext', 'agent', 'sessions.resolve', 'sessions.describe', 'sessions.reset'].includes(frame.method))).toHaveLength(0);
 expect(f.sockets[0].sent.filter(frame => frame.method === 'sessions.reset')).toHaveLength(1);
});

it('does not replay a START-pending input after reset when its old START receipt arrives late', async () => {
 const f = await fixture(), catalog = (await f.command('discover-start-pending')).catalog!;
 f.handler.handle({ type: 'receiveMessage', data: {
  fromUser: { uid: '7', name: 'user', userType: 1 },
  message: { id: 'old-input', roomId: '2', type: 1, roomType: 2, body: { content: 'old input must not cross reset' } },
 } });
 await waitFor(() => expect(f.hula.frames.filter(frame => frame.type === WSReqType.THINKING_START)).toHaveLength(1));
 const oldStart = f.hula.frames.find(frame => frame.type === WSReqType.THINKING_START)!.data;
 expect(f.store.pendingRuns()).toMatchObject([{ runId: oldStart.clientRunId, generation: 1 }]);
 expect(f.sockets[0].sent.filter(frame => frame.method === 'agent')).toHaveLength(0);
 expect((await f.command('reset-start-pending', { operation: 'invoke', capabilityId: 'session.reset', catalogVersion: catalog.version })).status).toBe('completed');
 expect(f.store.get('1', '2')!.generation).toBe(2);
 // A server receipt would grant any wrongly replayed START; do not mask an escaped input by withholding it.
 f.hula.onSend = frame => {
  if (frame.type === WSReqType.THINKING_START && frame.data.clientRunId !== oldStart.clientRunId) {
   queueMicrotask(() => f.handler.handle({ type: 'thinkingStart', data: { fromUid: '1', roomId: '2', triggerMsgId: 'old-input', thinkingId: 'wrong-new-grant', clientRunId: frame.data.clientRunId as string } }));
  }
 };
 f.handler.handle({ type: 'thinkingStart', data: { fromUid: '1', roomId: '2', triggerMsgId: 'old-input', thinkingId: 'late-old-grant', clientRunId: oldStart.clientRunId as string } });
 await waitFor(() => expect(f.store.pendingRuns().some(run => run.runId === oldStart.clientRunId)).toBe(false));
 // Let the fixture's 1ms debounce and any accidental native submission settle.
 await new Promise(resolve => setTimeout(resolve, 50));
 expect({
  starts: f.hula.frames.filter(frame => frame.type === WSReqType.THINKING_START).map(frame => frame.data.clientRunId),
  replyGrants: (f.store.get('1', '2')!.replyBindings ?? []).map(binding => binding.thinkingId),
  nativeSubmissions: f.sockets[0].sent.filter(frame => frame.method === 'agent').map(frame => frame.params.message),
  // No public diagnostic exposes retired entries; observe cleanup without injecting private state.
  remainingThinkingEntries: (f.handler as unknown as { thinkingSessions: Map<string, unknown> }).thinkingSessions.size,
 }).toEqual({ starts: [oldStart.clientRunId], replyGrants: [], nativeSubmissions: [], remainingThinkingEntries: 0 });
});

it('drops a transport retry queued before reset without erasing a genuinely new input', async () => {
 const f = await fixture({ debounce: { waitMs: 1000, maxWaitMs: 10000 } }), catalog = (await f.command('discover-queued-retry')).catalog!;
 vi.useFakeTimers();
 f.handler.handle({ type: 'receiveMessage', data: {
  fromUser: { uid: '7', name: 'user', userType: 1 },
  message: { id: 'queued-old-input', roomId: '2', type: 1, roomType: 2, body: { content: 'old queued input must not cross reset' } },
 } });
 await vi.advanceTimersByTimeAsync(1000);
 const oldStart = f.hula.frames.find(frame => frame.type === WSReqType.THINKING_START)!.data;
 expect(f.store.pendingRuns()).toMatchObject([{ runId: oldStart.clientRunId, generation: 1 }]);
 // Withhold the real public START receipt. Drain its normal 30s deadline and microtasks,
 // but not the newly scheduled 1s retry: the old slot is released while generation is still 1.
 await vi.advanceTimersByTimeAsync(30_000);
 expect(f.store.get('1', '2')!.generation).toBe(1);
 expect(f.store.pendingRuns()).toHaveLength(0);
 expect(new Set(f.hula.frames.filter(frame => frame.type === WSReqType.THINKING_START).map(frame => frame.data.clientRunId))).toEqual(new Set([oldStart.clientRunId]));
 expect(f.sockets[0].sent.filter(frame => frame.method === 'agent')).toHaveLength(0);
 expect((await f.command('reset-queued-retry', { operation: 'invoke', capabilityId: 'session.reset', catalogVersion: catalog.version })).status).toBe('completed');
 expect(f.store.get('1', '2')!.generation).toBe(2);
 f.hula.onSend = frame => {
  if (frame.type === WSReqType.THINKING_START && frame.data.clientRunId !== oldStart.clientRunId) {
   queueMicrotask(() => f.handler.handle({ type: 'thinkingStart', data: { fromUid: '1', roomId: '2', triggerMsgId: frame.data.triggerMsgId as string, thinkingId: 'new-input-grant', clientRunId: frame.data.clientRunId as string } }));
  }
 };
 f.handler.handle({ type: 'receiveMessage', data: {
  fromUser: { uid: '7', name: 'user', userType: 1 },
  message: { id: 'genuinely-new-input', roomId: '2', type: 1, roomType: 2, body: { content: 'new input survives reset' } },
 } });
 await vi.advanceTimersByTimeAsync(1000);
 await waitFor(() => expect(f.sockets[0].sent.filter(frame => frame.method === 'agent')).toHaveLength(1));
 expect({
  nativeSubmissions: f.sockets[0].sent.filter(frame => frame.method === 'agent').map(frame => frame.params.message),
  newStarts: f.hula.frames.filter(frame => frame.type === WSReqType.THINKING_START && frame.data.clientRunId !== oldStart.clientRunId).map(frame => frame.data.triggerMsgId),
  replyGrants: (f.store.get('1', '2')!.replyBindings ?? []).filter(binding => binding.thinkingId).map(binding => binding.thinkingId),
  pendingGenerations: f.store.pendingRuns().map(run => run.generation),
 }).toEqual({ nativeSubmissions: ['[HuLa 私聊]\n[user(7)]: new input survives reset'], newStarts: ['genuinely-new-input'], replyGrants: ['new-input-grant'], pendingGenerations: [2] });
});

it('keeps a retry generation-bound through preparation failure without replaying it after reset', async () => {
 const f = await fixture({ debounce: { waitMs: 1000, maxWaitMs: 10000 } }), catalog = (await f.command('discover-preparation-retry')).catalog!;
 vi.useFakeTimers();
 f.handler.handle({ type: 'receiveMessage', data: {
  fromUser: { uid: '7', name: 'user', userType: 1 },
  message: { id: 'preparation-old-input', roomId: '2', type: 1, roomType: 2, body: { content: 'old preparation retry must not cross reset' } },
 } });
 await vi.advanceTimersByTimeAsync(1000);
 const oldStart = f.hula.frames.find(frame => frame.type === WSReqType.THINKING_START)!.data;
 expect(f.store.pendingRuns()).toMatchObject([{ runId: oldStart.clientRunId, generation: 1 }]);
 await vi.advanceTimersByTimeAsync(30_000);
 expect(f.store.pendingRuns()).toHaveLength(0);
 // This is the public provider preparation boundary, not Handler/store private state.
 const prepare = vi.spyOn(f.driver, 'createRun').mockImplementationOnce(() => { throw new Error('temporary public provider preparation failure'); });
 await vi.advanceTimersByTimeAsync(1000);
 expect(prepare).toHaveBeenCalledTimes(1);
 expect(f.store.pendingRuns()).toHaveLength(0);
 expect(f.sockets[0].sent.filter(frame => frame.method === 'agent')).toHaveLength(0);
 expect((await f.command('reset-preparation-retry', { operation: 'invoke', capabilityId: 'session.reset', catalogVersion: catalog.version })).status).toBe('completed');
 expect(f.store.get('1', '2')!.generation).toBe(2);
 const grants: string[] = [];
 f.hula.onSend = frame => {
  if (frame.type === WSReqType.THINKING_START && frame.data.clientRunId !== oldStart.clientRunId) {
   grants.push(frame.data.clientRunId as string);
   queueMicrotask(() => f.handler.handle({ type: 'thinkingStart', data: { fromUid: '1', roomId: '2', triggerMsgId: frame.data.triggerMsgId as string, thinkingId: `preparation-grant-${grants.length}`, clientRunId: frame.data.clientRunId as string } }));
  }
 };
 f.handler.handle({ type: 'receiveMessage', data: {
  fromUser: { uid: '7', name: 'user', userType: 1 },
  message: { id: 'preparation-new-input', roomId: '2', type: 1, roomType: 2, body: { content: 'new input survives preparation failure' } },
 } });
 await vi.advanceTimersByTimeAsync(1000);
 await waitFor(() => expect(f.sockets[0].sent.filter(frame => frame.method === 'agent')).toHaveLength(1));
 const request = f.sockets[0].sent.find(frame => frame.method === 'agent')!;
 expect(request.params.message).toBe('[HuLa 私聊]\n[user(7)]: new input survives preparation failure');
 f.sockets[0].emit('message', Buffer.from(JSON.stringify({ type: 'res', id: request.id, ok: true, payload: { status: 'accepted', runId: 'new-after-preparation' } })));
 f.sockets[0].emit('message', Buffer.from(JSON.stringify({ type: 'event', event: 'agent', payload: { runId: 'new-after-preparation', seq: 1, stream: 'lifecycle', ts: Date.now(), data: { phase: 'end' } } })));
 await waitFor(() => expect(f.store.pendingRuns()).toHaveLength(0));
 // Completing the new turn drains the old failed-preparation pending item through the normal debounce.
 await vi.advanceTimersByTimeAsync(1000);
 expect({
  nativeSubmissions: f.sockets[0].sent.filter(frame => frame.method === 'agent').map(frame => frame.params.message),
  newStarts: f.hula.frames.filter(frame => frame.type === WSReqType.THINKING_START && frame.data.clientRunId !== oldStart.clientRunId).map(frame => frame.data.triggerMsgId),
  grants: grants.length,
 }).toEqual({ nativeSubmissions: ['[HuLa 私聊]\n[user(7)]: new input survives preparation failure'], newStarts: ['preparation-new-input'], grants: 1 });
});

it('flushes a genuinely new queued input when a stale retry retires after anti-loop backoff', async () => {
 const f = await fixture({ debounce: { waitMs: 1000, maxWaitMs: 10000 }, respondToAi: true }), catalog = (await f.command('discover-backoff-retry')).catalog!;
 vi.useFakeTimers();
 f.hula.onSend = frame => {
  if (frame.type === WSReqType.THINKING_START && frame.data.triggerMsgId !== 'backoff-old-input') {
   queueMicrotask(() => f.handler.handle({ type: 'thinkingStart', data: { fromUid: '1', roomId: '2', triggerMsgId: frame.data.triggerMsgId as string, thinkingId: `backoff-grant-${frame.data.clientRunId}`, clientRunId: frame.data.clientRunId as string } }));
  }
 };
 // Reach the real AI-to-AI backoff threshold using completed public ordinary turns, not a mocked guard.
 for (let i = 0; i < 6; i++) {
  f.handler.handle({ type: 'receiveMessage', data: {
   fromUser: { uid: '8', name: 'peer', userType: 4 },
   message: { id: `prime-${i}`, roomId: '2', type: 1, roomType: 2, body: { content: `prime AI round ${i}` } },
  } });
  await vi.advanceTimersByTimeAsync(1000);
  await waitFor(() => expect(f.sockets[0].sent.filter(frame => frame.method === 'agent')).toHaveLength(i + 1));
  const request = f.sockets[0].sent.filter(frame => frame.method === 'agent')[i], runId = `prime-native-${i}`;
  f.sockets[0].emit('message', Buffer.from(JSON.stringify({ type: 'res', id: request.id, ok: true, payload: { status: 'accepted', runId } })));
  f.sockets[0].emit('message', Buffer.from(JSON.stringify({ type: 'event', event: 'agent', payload: { runId, seq: 1, stream: 'lifecycle', ts: Date.now(), data: { phase: 'end' } } })));
  await waitFor(() => expect(f.store.pendingRuns()).toHaveLength(0));
 }
 f.handler.handle({ type: 'receiveMessage', data: {
  fromUser: { uid: '8', name: 'peer', userType: 4 },
  message: { id: 'backoff-old-input', roomId: '2', type: 1, roomType: 2, body: { content: 'old backoff retry must not cross reset' } },
 } });
 await vi.advanceTimersByTimeAsync(1000);
 await vi.advanceTimersByTimeAsync(5000);
 const oldStart = f.hula.frames.find(frame => frame.type === WSReqType.THINKING_START && frame.data.triggerMsgId === 'backoff-old-input')!.data;
 expect(f.store.pendingRuns()).toMatchObject([{ runId: oldStart.clientRunId, generation: 1 }]);
 // This real queued AI input supplies the next batch's AI flag while the old START is unresolved.
 f.handler.handle({ type: 'receiveMessage', data: {
  fromUser: { uid: '8', name: 'peer', userType: 4 },
  message: { id: 'backoff-queued-ai', roomId: '2', type: 1, roomType: 2, body: { content: 'queued AI input' } },
 } });
 await vi.advanceTimersByTimeAsync(30_000);
 expect(f.store.pendingRuns()).toHaveLength(0);
 await vi.advanceTimersByTimeAsync(1000);
 expect(f.sockets[0].sent.filter(frame => frame.method === 'agent')).toHaveLength(6);
 expect((await f.command('reset-backoff-retry', { operation: 'invoke', capabilityId: 'session.reset', catalogVersion: catalog.version })).status).toBe('completed');
 expect(f.store.get('1', '2')!.generation).toBe(2);
 f.handler.handle({ type: 'receiveMessage', data: {
  fromUser: { uid: '7', name: 'user', userType: 1 },
  message: { id: 'backoff-new-input', roomId: '2', type: 1, roomType: 2, body: { content: 'new human input survives stale backoff' } },
 } });
 await vi.advanceTimersByTimeAsync(5000);
 await vi.advanceTimersByTimeAsync(1000);
 // The obsolete retry must retire AND release the still-valid queue; no further external trigger is sent.
 expect(f.hula.frames.some(frame => frame.type === WSReqType.THINKING_START && frame.data.triggerMsgId === 'backoff-new-input')).toBe(true);
 await waitFor(() => expect(f.sockets[0].sent.filter(frame => frame.method === 'agent')).toHaveLength(7));
 const submitted = f.sockets[0].sent.filter(frame => frame.method === 'agent').map(frame => frame.params.message as string);
 expect(submitted.some(message => message.includes('old backoff retry must not cross reset'))).toBe(false);
 expect(submitted[6]).toContain('new human input survives stale backoff');
 expect(f.store.pendingRuns().map(run => run.generation)).toEqual([2]);
});

it.each(['before', 'after'])('fences real cached authorization changes %s native mutation', async when => {
 const f = await fixture(), catalog = (await f.command('discover-epoch')).catalog!;
 if (when === 'before') f.native.onResolve = () => f.setEpoch('revoked');
 else f.native.onReset = () => f.setEpoch('revoked');
 expect((await f.command('reset-epoch', { operation: 'invoke', capabilityId: 'session.reset', catalogVersion: catalog.version })).status).toBe(when === 'before' ? 'failed' : 'unknown');
 expect(f.store.get('1', '2')!.generation).toBe(1);
 expect(f.sockets[0].sent.filter(frame => frame.method === 'sessions.reset')).toHaveLength(when === 'before' ? 0 : 1);
});

it.each(['refused', 'completed'])('does not queue ordinary input during a held reset that is later %s', async outcome => {
  const f = await fixture(), catalog = (await f.command('discover-held-reset')).catalog!;
  const reset = { operation: 'invoke', capabilityId: 'session.reset', catalogVersion: catalog.version };
  vi.useFakeTimers();
  const gate = Promise.withResolvers<void>();
  f.native.onReset = () => gate.promise;
  f.native.denied = outcome === 'refused';
  const original = f.command('held-reset', reset);
  try {
   await waitFor(() => expect(f.sockets[0].sent.filter(frame => frame.method === 'sessions.reset')).toHaveLength(1));
   f.sendCommand('held-reset', { ...reset, reconcileOnly: true });
   await vi.advanceTimersByTimeAsync(0);
   expect(f.receipts.some(r => r.requestId === 'held-reset')).toBe(false);
   expect(f.sockets[0].sent.filter(frame => frame.method === 'sessions.reset')).toHaveLength(1);
   expect(f.store.getControl('1', '2', 'held-reset')).toMatchObject({ state: 'submitted' });
   f.handler.handle({ type: 'receiveMessage', data: {
    fromUser: { uid: '7', name: 'user', userType: 1 },
    message: { id: 'blocked-during-reset', roomId: '2', type: 1, roomType: 2, body: { content: 'blocked input must not replay' } },
   } });
   f.handler.handle({ type: 'receiveMessage', data: {
    fromUser: { uid: '9', name: 'group-user', userType: 1 },
    message: { id: 'unmentioned-during-reset', roomId: '2', type: 1, roomType: 1, body: { content: 'unmentioned text must not become later context' } },
   } });
   await waitFor(() => expect(f.notices).toEqual([expect.stringContaining('不会自动重试')]));
  } finally { gate.resolve(); }
  const status = outcome === 'refused' ? 'failed' : 'completed';
  // The overlapping query did not publish; the original caller now receives the native outcome.
  await original;
  await waitFor(() => expect(f.store.getControl('1', '2', 'held-reset')?.receipt?.status).toBe(status));
  expect((await f.command('held-reset', { ...reset, reconcileOnly: true })).status).toBe(status);
  f.hula.onSend = frame => {
   if (frame.type === WSReqType.THINKING_START) queueMicrotask(() => f.handler.handle({ type: 'thinkingStart', data: {
    fromUid: '1', roomId: '2', triggerMsgId: frame.data.triggerMsgId as string, clientRunId: frame.data.clientRunId as string, thinkingId: 'after-held-reset',
   } }));
  };
  await f.setEpoch('epoch-after-held-reset');
  f.handler.handle({ type: 'receiveMessage', data: {
   fromUser: { uid: '8', name: 'next', userType: 1 },
   message: { id: 'fresh-after-reset', roomId: '2', type: 1, roomType: 1, body: { content: 'fresh input', atUidList: ['1'] } },
  } });
  await waitFor(() => expect(f.sockets[0].sent.filter(frame => frame.method === 'agent')).toHaveLength(1));
  const call = f.sockets[0].sent.find(frame => frame.method === 'agent')!, runId = 'after-held-reset';
  expect(call.params.message).toBe('[HuLa 群聊]\n[next(8)]: fresh input');
  f.sockets[0].emit('message', Buffer.from(JSON.stringify({ type: 'res', id: call.id, ok: true, payload: { status: 'accepted', runId } })));
  f.sockets[0].emit('message', Buffer.from(JSON.stringify({ type: 'event', event: 'agent', payload: { runId, seq: 1, stream: 'lifecycle', ts: Date.now(), data: { phase: 'end' } } })));
  await waitFor(() => expect(f.store.pendingRuns()).toHaveLength(0));
  await vi.advanceTimersByTimeAsync(10);
  expect(f.hula.frames.filter(frame => frame.type === WSReqType.THINKING_START).map(frame => frame.data.triggerMsgId)).toEqual(['fresh-after-reset']);
  expect(f.sockets[0].sent.filter(frame => frame.method === 'agent')).toHaveLength(1);
  expect(f.sockets[0].sent.filter(frame => frame.method === 'sessions.reset')).toHaveLength(1);
});

it('does not admit already-signing media into a replacement generation', async () => {
  const signing = Promise.withResolvers<{ url: string }>();
  const signDownload = vi.fn(() => signing.promise);
  const f = await fixture({ signDownload }), catalog = (await f.command('discover-before-media-reset')).catalog!;
  f.handler.handle({ type: 'receiveMessage', data: {
   fromUser: { uid: '7', name: 'user', userType: 1 },
   message: { id: 'media-before-reset', roomId: '2', type: 4, roomType: 2, body: { fileName: 'fixture.txt' } },
  } });
  try {
   await waitFor(() => expect(signDownload).toHaveBeenCalledTimes(1));
   expect(await f.command('reset-while-signing', { operation: 'invoke', capabilityId: 'session.reset', catalogVersion: catalog.version })).toMatchObject({ status: 'completed', effect: { generation: '2' } });
  } finally { signing.resolve({ url: 'https://fixture.invalid/signed' }); }
  await waitFor(() => expect(f.notices).toEqual([expect.stringContaining('本条媒体消息未执行')]));
  expect(f.hula.frames.some(frame => frame.type === WSReqType.THINKING_START)).toBe(false);
  expect(f.sockets[0].sent.some(frame => frame.method === 'agent')).toBe(false);
});

it('reconciles the exact late native denial after the command watchdog without resetting again', async () => {
  const f = await fixture(), catalog = (await f.command('discover-late-denial')).catalog!;
  const reset = { operation: 'invoke', capabilityId: 'session.reset', catalogVersion: catalog.version };
  vi.useFakeTimers();
  f.native.denied = true;
  f.native.onResolve = () => new Promise(resolve => setTimeout(resolve, 5000));
  f.native.onReset = () => new Promise(resolve => setTimeout(resolve, 11000));
  const original = f.command('late-reset-denial', reset);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await original).toMatchObject({ status: 'unknown', error: 'native_timeout' });
  expect(f.store.get('1', '2')?.generation).toBe(1);
  await vi.advanceTimersByTimeAsync(1500);
  expect((await f.command('late-reset-denial', { ...reset, reconcileOnly: true }))).toMatchObject({ status: 'failed', reconciled: true, nativeRef: { sessionId: f.rawK } });
  f.native.onResolve = undefined;
  expect((await f.command('compact-after-late-denial', { ...reset, capabilityId: 'session.compact' })).status).toBe('completed');
  expect(f.sockets[0].sent.filter(frame => frame.method === 'sessions.reset')).toHaveLength(1);
  expect(f.sockets[0].sent.filter(frame => frame.method === 'sessions.compact')).toHaveLength(1);
});

it('preserves native permission denial without retrying or escalating the connection', async () => {
 const f = await fixture(), catalog = (await f.command('discover-native-denial')).catalog!;
 f.native.denied = true;
 expect((await f.command('reset-native-denial', { operation: 'invoke', capabilityId: 'session.reset', catalogVersion: catalog.version })).status).toBe('failed');
 expect((await f.command('compact-after-native-denial', { operation: 'invoke', capabilityId: 'session.compact', catalogVersion: catalog.version })).status).toBe('completed');
 expect(f.sockets[0].sent.filter(frame => frame.method === 'sessions.compact')).toHaveLength(1);
 expect(f.sockets).toHaveLength(1);
 expect(f.sockets[0].sent.filter(frame => frame.method === 'sessions.reset')).toHaveLength(1);
 expect(f.store.get('1', '2')!.generation).toBe(1);
});
