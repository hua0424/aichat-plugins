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
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close(); });

// The external WS protocol is fake; Handler, command admission, journal and conversation leases are real.
async function fixture(options: { scopes?: string[]; version?: string; protocol?: number } = {}) {
 const home = await mkdtemp(join(tmpdir(), 'openclaw-compact-'));
 const store = new ConversationStore({ home, serverNamespace: 'server', activeUids: new Set(['1']), activeProviders: new Map([['1', 'openclaw']]) });
 const token = store.contextKey('1', '2'), rawK = `${token}:aiclaw-1-room-2`, canonicalK = 'agent:native-a:' + rawK;
 store.registerNative('openclaw', token, '1', '2', { token, nativeRef: rawK });
 store.selectModel('1', '2', 1, { providerID: 'provider-b', modelID: 'model-b' });
 const native: { payload: unknown; description: unknown; beforeResolve?: () => void | Promise<void>; beforeCompact?: () => void | Promise<void>; errorCode?: string; dropReply?: boolean } = {
  payload: { ok: true, key: canonicalK, compacted: true, result: { summary: 'native summary', firstKeptEntryId: 'kept-entry', tokensBefore: 100, tokensAfter: 50 } },
  description: { session: { key: canonicalK, sessionId: 'native-session-old' } },
 };
 class Socket extends EventEmitter {
  readonly sent: Array<{ id: string; method: string; params: Record<string, unknown> }> = [];
  reply(id: string, payload: unknown) { this.emit('message', Buffer.from(JSON.stringify({ type: 'res', id, ok: true, payload }))); }
  send(data: string) {
   const frame = JSON.parse(data); this.sent.push(frame);
   queueMicrotask(async () => {
    if (frame.method === 'connect') this.reply(frame.id, { type: 'hello-ok', protocol: options.protocol ?? 4, server: { version: options.version ?? '2026.6.5', connId: 'compact-connection' }, auth: { role: 'operator', scopes: options.scopes ?? ['operator.admin', 'operator.read'] } });
    if (frame.method === 'aichat.gatewayContext') this.reply(frame.id, { schema: 1, healthy: false });
    if (frame.method === 'sessions.resolve') { await native.beforeResolve?.(); this.reply(frame.id, { ok: true, key: canonicalK }); }
    if (frame.method === 'sessions.describe') this.reply(frame.id, native.description);
    if (frame.method === 'sessions.compact') {
     await native.beforeCompact?.();
     if (native.dropReply) return;
     if (native.errorCode) this.emit('message', Buffer.from(JSON.stringify({ type: 'res', id: frame.id, ok: false, error: { code: native.errorCode, message: 'native permission denied' } })));
     else this.reply(frame.id, native.payload);
    }
   });
  }
  close() { this.emit('close', 1000, Buffer.from('test')); }
 }
 const sockets: Socket[] = [];
 const factory = () => { const socket = new Socket(); sockets.push(socket); queueMicrotask(() => { socket.emit('open'); socket.emit('message', Buffer.from(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'challenge' } }))); }); return socket as unknown as WebSocket; };
 const driver = new OpenclawDriver('ws://fake.invalid', '', factory, home, undefined, join(home, 'run-bind'));
 const receipts: AgentCommandResponse[] = [];
 const hula: { frames: Array<{ type: number; data: Record<string, unknown> }>; onSend?: (frame: { type: number; data: Record<string, unknown> }) => void } = { frames: [] };
 let epoch = 'epoch';
 const handler = new MessageHandler({ send: (type: number, data: Record<string, unknown>) => { const frame = { type, data }; hula.frames.push(frame); hula.onSend?.(frame); }, isConnected: true } as unknown as HulaWSClient, driver, '1', { reportAgentCommandResult: async (receipt: AgentCommandResponse) => { receipts.push(receipt); }, listSelfGroupConfigs: async () => [{ roomId: '2', approved: 1, authorizationEpoch: epoch }] } as unknown as HulaApiClient, { waitMs: 1, maxWaitMs: 1 }, () => {}, () => store, home);
 cleanup.push(async () => { handler.destroy(); await driver.disconnect(); store.close(); await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
 await driver.connect(); await handler.prewarmGroupConfigs();
 const command = async (requestId: string, patch: Record<string, unknown> = {}) => {
  const start = receipts.length;
  handler.handle({ type: 'agentCommand', data: { requestId, roomId: '2', aiclawUid: '1', operation: 'discover', context: { roomType: 2, counterpartUid: 'owner', isOwner: true, authorizationEpoch: epoch }, ...patch } });
  await waitFor(() => expect(receipts.slice(start).find(receipt => receipt.requestId === requestId)).toBeDefined());
  return receipts.slice(start).find(receipt => receipt.requestId === requestId)!;
 };
 const catalog = (await command('discover')).catalog!;
 const invoke = (requestId: string, patch: Record<string, unknown> = {}) => command(requestId, { operation: 'invoke', capabilityId: 'session.compact', catalogVersion: catalog.version, ...patch });
 return { store, driver, sockets, native, rawK, canonicalK, command, invoke, catalog, handler, hula, setEpoch: async (value: string) => { epoch = value; await handler.prewarmGroupConfigs(); } };
}

it('compacts the existing idle conversation without resetting core generation or model selection', async () => {
 const f = await fixture(), before = f.store.get('1', '2')!;
 const receipt = await f.invoke('compact-idle');
 expect(receipt.status).toBe('completed');
 expect(f.catalog.capabilities.find(capability => capability.id === 'session.compact')).toMatchObject({ supported: true, executable: true, parameters: [] });
 expect(receipt).toMatchObject({ generation: '1', nativeRef: { sessionId: f.rawK }, effect: { kind: 'compact', controlId: 'compact-idle', summary: true } });
 expect(f.sockets[0].sent.filter(frame => frame.method === 'sessions.resolve').map(frame => frame.params)).toEqual([{ key: f.rawK }]);
 expect(f.sockets[0].sent.filter(frame => frame.method === 'sessions.compact').map(frame => frame.params)).toEqual([{ key: f.canonicalK }]);
 const after = f.store.get('1', '2')!;
 expect({ generation: after.generation, contextKey: after.contextKey, nativeState: after.nativeState, selectedModel: after.selectedModel }).toEqual({ generation: before.generation, contextKey: before.contextKey, nativeState: before.nativeState, selectedModel: before.selectedModel });
 expect(after.pendingRuns ?? []).toHaveLength(0);
 expect(after.replyBindings ?? []).toHaveLength(0);
 expect(receipt.nativeResult).toEqual({ summary: 'native summary' });
 expect((await f.invoke('compact-idle', { reconcileOnly: true })).nativeResult).toEqual({ summary: 'native summary' });
 expect(f.sockets[0].sent.filter(frame => frame.method === 'sessions.compact')).toHaveLength(1);
});

it.each([
 { ok: false, compacted: false, reason: 'native compact failed', status: 'failed' },
 { ok: true, compacted: false, reason: 'no transcript', status: 'noop' },
])('uses the Native inner outcome rather than the outer ACK: $status', async ({ status, ...outcome }) => {
 const f = await fixture(); f.native.payload = { key: f.canonicalK, ...outcome };
 const receipt = await f.invoke('compact-outcome');
 expect(receipt).toMatchObject({ status, nativeResult: { reason: outcome.reason }, generation: '1', nativeRef: { sessionId: f.rawK } });
 expect(receipt.effect).toBeUndefined();
 expect((await f.invoke('compact-outcome')).status).toBe(status);
 expect((await f.invoke('compact-outcome', { reconcileOnly: true })).status).toBe(status);
 expect(f.sockets[0].sent.filter(frame => frame.method === 'sessions.compact')).toHaveLength(1);
});

it.each([undefined, { summary: '' }, { summary: '   ' }, { summary: '', sessionId: 'native-rotated-session', sessionFile: '/native/rotated.jsonl' }])(
 'allows Native soft compaction without a new summary or a fixed Native S: %j', async result => {
 const f = await fixture(), before = f.store.get('1', '2')!;
 f.native.payload = { ok: true, key: f.canonicalK, compacted: true, ...(result ? { result } : {}) };
 expect(await f.invoke('compact-soft')).toMatchObject({ status: 'completed', effect: { kind: 'compact', controlId: 'compact-soft', summary: false } });
 expect((await f.invoke('compact-soft', { reconcileOnly: true })).status).toBe('completed');
 expect(f.store.get('1', '2')).toMatchObject({ generation: before.generation, contextKey: before.contextKey, nativeState: before.nativeState, selectedModel: before.selectedModel });
 expect(f.sockets[0].sent.filter(frame => frame.method === 'sessions.compact')).toHaveLength(1);
});

it.each([
 {}, { status: 'accepted' }, { ok: true, key: undefined, compacted: true },
 { ok: true, key: 'wrong-key', compacted: true },
 { ok: true, compacted: 'true' }, { ok: true, compacted: true, result: null },
 { ok: true, compacted: true, result: {} }, { ok: true, compacted: true, result: { summary: true } },
 { ok: true, compacted: false, reason: 5 },
])('retains an unproven outcome as unknown and never resubmits: %j', async payload => {
 const f = await fixture();
 f.native.payload = 'key' in payload || Object.keys(payload).length === 0 || 'status' in payload ? payload : { key: f.canonicalK, ...payload };
 const receipt = await f.invoke('compact-unproven');
 expect(receipt.status).toBe('unknown');
 expect(receipt.effect).toBeUndefined();
 expect((await f.invoke('compact-unproven')).status).toBe('unknown');
 expect((await f.invoke('compact-unproven', { reconcileOnly: true })).status).toBe('unknown');
 expect(f.store.getControl('1', '2', 'compact-unproven')?.receipt?.status).toBe('unknown');
 expect(f.sockets[0].sent.filter(frame => frame.method === 'sessions.compact')).toHaveLength(1);
});

it.each([{ scopes: ['operator.read'] }, { version: 'other-version' }, { protocol: 3 }])(
 'does not infer compact authority from an otherwise connected gateway: %j', async options => {
 const f = await fixture(options);
 expect(f.catalog.capabilities.some(capability => capability.id === 'session.compact' && capability.executable)).toBe(false);
 expect((await f.invoke('compact-no-authority')).status).toBe('failed');
 expect(f.sockets[0].sent.filter(frame => frame.method === 'sessions.compact')).toHaveLength(0);
});

it('persists recovery and submitted evidence before Native mutation and preserves permission denial', async () => {
 const f = await fixture(); f.native.errorCode = 'FORBIDDEN';
 f.native.beforeCompact = () => {
  expect(f.store.getControl('1', '2', 'compact-denied')).toMatchObject({ state: 'submitted', nativeRef: { sessionId: f.rawK }, recovery: { version: 1, value: { key: f.canonicalK, previousSessionId: 'native-session-old' } } });
 };
 expect((await f.invoke('compact-denied')).status).toBe('failed');
 expect((await f.invoke('compact-denied', { reconcileOnly: true })).status).toBe('failed');
 expect(f.sockets).toHaveLength(1);
 expect(f.sockets[0].sent.filter(frame => frame.method === 'sessions.compact')).toHaveLength(1);
});

it.each(['before', 'after'])('fences authorization epoch changes %s Native mutation', async when => {
 const f = await fixture();
 if (when === 'before') f.native.beforeResolve = () => f.setEpoch('revoked');
 else f.native.beforeCompact = () => f.setEpoch('revoked');
 expect((await f.invoke('compact-epoch')).status).toBe(when === 'before' ? 'failed' : 'unknown');
 expect(f.store.get('1', '2')!.generation).toBe(1);
 expect(f.sockets[0].sent.filter(frame => frame.method === 'sessions.compact')).toHaveLength(when === 'before' ? 0 : 1);
});

it.each(['before', 'after'])('fences core generation changes %s Native mutation', async when => {
 const f = await fixture();
 const changeGeneration = () => { f.store.reset('1', '2'); };
 if (when === 'before') f.native.beforeResolve = changeGeneration;
 else f.native.beforeCompact = changeGeneration;
 expect((await f.invoke('compact-generation')).status).toBe(when === 'before' ? 'failed' : 'unknown');
 expect(f.store.get('1', '2')!.generation).toBe(2);
 expect(f.sockets[0].sent.filter(frame => frame.method === 'sessions.compact')).toHaveLength(when === 'before' ? 0 : 1);
});

it.each(['before', 'after'])('never borrows a reconnected socket %s Native mutation', async when => {
 const f = await fixture();
 const reconnect = async () => { await f.driver.disconnect(); await f.driver.connect(); };
 if (when === 'before') f.native.beforeResolve = reconnect;
 else f.native.beforeCompact = reconnect;
 expect((await f.invoke('compact-reconnect')).status).toBe(when === 'before' ? 'failed' : 'unknown');
 expect(f.sockets).toHaveLength(2);
 expect((await f.invoke('compact-reconnect', { reconcileOnly: true })).status).toBe(when === 'before' ? 'failed' : 'unknown');
 expect(f.sockets.flatMap(socket => socket.sent).filter(frame => frame.method === 'sessions.compact')).toHaveLength(when === 'before' ? 0 : 1);
});

it('records side-effect-without-response as unknown after the existing deadline and never resends', async () => {
 const f = await fixture(); f.native.dropReply = true;
 vi.useFakeTimers();
 f.handler.handle({ type: 'agentCommand', data: { requestId: 'compact-timeout', roomId: '2', aiclawUid: '1', operation: 'invoke', capabilityId: 'session.compact', catalogVersion: f.catalog.version,
  context: { roomType: 2, counterpartUid: 'owner', isOwner: true, authorizationEpoch: 'epoch' } } });
 await vi.advanceTimersByTimeAsync(15_001);
 expect(f.store.getControl('1', '2', 'compact-timeout')?.receipt?.status).toBe('unknown');
 expect((await f.invoke('compact-timeout', { reconcileOnly: true })).status).toBe('unknown');
 expect(f.sockets[0].sent.filter(frame => frame.method === 'sessions.compact')).toHaveLength(1);
});

it('does not impose an AIChat busy rejection or pre-abort on an accepted Native run', async () => {
 const f = await fixture();
 f.hula.onSend = frame => {
  if (frame.type === WSReqType.THINKING_START) queueMicrotask(() => f.handler.handle({ type: 'thinkingStart', data: { fromUid: '1', roomId: '2', triggerMsgId: frame.data.triggerMsgId as string, thinkingId: 'ordinary-grant', clientRunId: frame.data.clientRunId as string } }));
 };
 f.handler.handle({ type: 'receiveMessage', data: { fromUser: { uid: '7', name: 'user', userType: 1 }, message: { id: 'ordinary-input', roomId: '2', type: 1, roomType: 2, body: { content: 'ordinary input before compact' } } } });
 await waitFor(() => expect(f.sockets[0].sent.filter(frame => frame.method === 'agent')).toHaveLength(1));
 const agent = f.sockets[0].sent.find(frame => frame.method === 'agent')!;
 f.sockets[0].reply(agent.id, { status: 'accepted', runId: 'ordinary-native-run' });
 const before = f.store.get('1', '2')!;
 f.native.beforeCompact = () => { expect(f.store.pendingRuns()).toHaveLength(1); };
 expect((await f.invoke('compact-active')).status).toBe('completed');
 expect(f.store.get('1', '2')).toMatchObject({ generation: before.generation, contextKey: before.contextKey, selectedModel: before.selectedModel, pendingRuns: before.pendingRuns, replyBindings: before.replyBindings });
 expect(f.sockets[0].sent.filter(frame => !['connect', 'aichat.gatewayContext', 'agent', 'sessions.resolve', 'sessions.describe', 'sessions.compact'].includes(frame.method))).toHaveLength(0);
 expect(f.sockets[0].sent.filter(frame => frame.method === 'agent')).toHaveLength(1);
 expect(f.hula.frames.filter(frame => frame.type === WSReqType.THINKING_START)).toHaveLength(1);
 f.sockets[0].emit('message', Buffer.from(JSON.stringify({ type: 'event', event: 'agent', payload: { runId: 'ordinary-native-run', seq: 1, stream: 'lifecycle', ts: Date.now(), data: { phase: 'end' } } })));
 await waitFor(() => expect(f.store.pendingRuns()).toHaveLength(0));
});
