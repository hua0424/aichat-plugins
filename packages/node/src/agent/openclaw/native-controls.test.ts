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
 const native: { payload: unknown; description: unknown; models: unknown; modelPayload?: unknown; selectedModel?: string; beforeResolve?: () => void | Promise<void>; beforeCompact?: () => void | Promise<void>; beforePatch?: () => void | Promise<void>; afterPatch?: (model: string) => void | Promise<void>; errorCode?: string; modelErrorCode?: string; patchErrorCode?: string; dropReply?: boolean; dropModels?: boolean; dropPatch?: boolean } = {
  payload: { ok: true, key: canonicalK, compacted: true, result: { summary: 'native summary', firstKeptEntryId: 'kept-entry', tokensBefore: 100, tokensAfter: 50 } },
  description: { session: { key: canonicalK, sessionId: 'native-session-old' } },
  models: { models: [{ provider: 'provider-c', id: 'model-c', name: 'Model C', available: false }, { provider: 'provider-d', id: 'model-d', name: 'Model D', available: true }] },
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
    if (frame.method === 'models.list') {
     if (native.dropModels) return;
     if (native.modelErrorCode) this.emit('message', Buffer.from(JSON.stringify({ type: 'res', id: frame.id, ok: false, error: { code: native.modelErrorCode, message: 'catalog unavailable' } })));
     else this.reply(frame.id, native.models);
    }
    if (frame.method === 'sessions.patch') {
     await native.beforePatch?.();
     if (native.patchErrorCode) { this.emit('message', Buffer.from(JSON.stringify({ type: 'res', id: frame.id, ok: false, error: { code: native.patchErrorCode, message: 'model not allowed' } }))); return; }
     const model = String(frame.params.model), slash = model.indexOf('/');
     native.selectedModel = model;
     const payload = native.modelPayload ?? { ok: true, key: canonicalK, entry: { sessionId: 'native-session-old' }, resolved: { modelProvider: model.slice(0, slash), model: model.slice(slash + 1) } };
     await native.afterPatch?.(model);
     if (!native.dropPatch) this.reply(frame.id, payload);
    }
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
 const modelChoice = async () => ({
  capabilityId: 'model.set', catalogVersion: (await command('browse-model-choice', { capabilityId: 'model.set' })).catalog!.version,
  parameters: { providerId: 'provider-c', modelId: 'model-c' },
 });
 return { store, driver, sockets, native, rawK, canonicalK, command, invoke, modelChoice, catalog, handler, hula, setEpoch: async (value: string) => { epoch = value; await handler.prewarmGroupConfigs(); } };
}

it('selects an existing Native session model for the next request, not the live stream', async () => {
 const f = await fixture(), before = f.store.get('1', '2')!;
 const catalog = (await f.command('discover-model', { capabilityId: 'model.set' })).catalog!;
 expect(catalog.version).toMatch(/^openclaw-models:[a-f0-9]{64}:[a-f0-9]{64}$/);
 expect(catalog.version.split(':')[1]).toBe(f.catalog.version.split(':')[1]);
 expect(catalog.models?.items).toContainEqual({ providerId: 'provider-c', modelId: 'model-c', label: 'Model C', connected: false });
 f.native.beforePatch = () => expect(f.store.getControl('1', '2', 'select-model')).toMatchObject({ state: 'submitted', nativeRef: { sessionId: f.rawK } });
 const patch = { capabilityId: 'model.set', catalogVersion: catalog.version, parameters: { providerId: 'provider-c', modelId: 'model-c' } };
 expect(await f.invoke('select-model', patch)).toMatchObject({ status: 'completed', generation: '1', nativeRef: { sessionId: f.rawK }, effect: { kind: 'model', providerId: 'provider-c', modelId: 'model-c', effective: 'next_request' } });
 expect(f.sockets[0].sent.filter(frame => frame.method === 'sessions.patch').map(frame => frame.params)).toEqual([{ key: f.canonicalK, model: 'provider-c/model-c' }]);
 const after = f.store.get('1', '2')!;
 expect({ generation: after.generation, contextKey: after.contextKey, nativeState: after.nativeState }).toEqual({ generation: before.generation, contextKey: before.contextKey, nativeState: before.nativeState });
 expect(after.selectedModel).toEqual(before.selectedModel); // Native is authoritative; do not mint a shadow of current/actual selection.
 expect((await f.invoke('select-model', { ...patch, reconcileOnly: true })).status).toBe('completed');
 expect(f.sockets[0].sent.filter(frame => frame.method === 'sessions.patch')).toHaveLength(1);
});

it('keeps Native authoritative when model patch replies arrive in reverse order', async () => {
 const f = await fixture(), before = f.store.get('1', '2')!.selectedModel;
 const catalog = (await f.command('discover-model-race', { capabilityId: 'model.set' })).catalog!;
 const patch = (providerId: string, modelId: string) => ({ capabilityId: 'model.set', catalogVersion: catalog.version, parameters: { providerId, modelId } });
 let release!: () => void;
 const held = new Promise<void>(resolve => { release = resolve; });
 f.native.afterPatch = model => model === 'provider-c/model-c' ? held : undefined;
 const first = f.invoke('model-first', patch('provider-c', 'model-c'));
 await waitFor(() => expect(f.native.selectedModel).toBe('provider-c/model-c'));
 try {
  expect(await f.invoke('model-second', patch('provider-d', 'model-d'))).toMatchObject({ requestId: 'model-second', status: 'completed', effect: { kind: 'model', providerId: 'provider-d', modelId: 'model-d', effective: 'next_request' } });
 } finally { release(); }
 expect(await first).toMatchObject({ requestId: 'model-first', status: 'completed', effect: { kind: 'model', providerId: 'provider-c', modelId: 'model-c', effective: 'next_request' } });
 expect(f.native.selectedModel).toBe('provider-d/model-d');
 expect(f.store.get('1', '2')!.selectedModel).toEqual(before);
 expect(f.sockets[0].sent.filter(frame => frame.method === 'sessions.patch').map(frame => frame.params.model)).toEqual(['provider-c/model-c', 'provider-d/model-d']);
});

it('paginates and filters the same complete model snapshot', async () => {
 const f = await fixture();
 f.native.models = { models: [...Array.from({ length: 205 }, (_, i) => ({ provider: 'provider-c', id: `model-${String(i).padStart(3, '0')}`, name: i === 0 ? 'x'.repeat(300) : `Model ${i}`, available: true })),
  { provider: 'provider-c', id: 'model-000', name: 'duplicate' }, { provider: '', id: 'bad' }, { provider: 'broken' }, null] };
 const first = (await f.command('models-page-1', { capabilityId: 'model.set' })).catalog!;
 const second = (await f.command('models-page-2', { capabilityId: 'model.set', parameters: { offset: 100 } })).catalog!;
 const filtered = (await f.command('models-filtered', { capabilityId: 'model.set', parameters: { query: 'MODEL-204' } })).catalog!;
 expect(first.version).not.toBe(f.catalog.version);
 expect([second.version, filtered.version]).toEqual([first.version, first.version]);
 expect(first.models).toMatchObject({ total: 205, offset: 0, nextOffset: 100 }); expect(first.models!.items).toHaveLength(100);
 expect(first.models!.items[0].label).toHaveLength(256);
 expect(second.models).toMatchObject({ total: 205, offset: 100, nextOffset: 200 }); expect(second.models!.items).toHaveLength(100);
 expect(filtered.models).toEqual({ total: 1, offset: 0, items: [{ providerId: 'provider-c', modelId: 'model-204', label: 'Model 204', connected: true }] });
 expect(await f.invoke('model-page-choice', { capabilityId: 'model.set', catalogVersion: filtered.version, parameters: { providerId: 'provider-c', modelId: 'model-204' } })).toMatchObject({ status: 'completed', effect: { modelId: 'model-204' } });
 expect(f.sockets[0].sent.filter(frame => frame.method === 'models.list').map(frame => frame.params)).toEqual(Array.from({ length: 4 }, () => ({ view: 'default' })));
});

it.each([null, {}, { key: 'wrong-key', sessionId: 'native-session-old' }, 'missing-id'])('never creates a model session from an absent or unproven S: %j', async session => {
 const f = await fixture(); f.native.description = { session: session === 'missing-id' ? { key: f.canonicalK } : session };
 expect(await f.invoke('model-no-session', await f.modelChoice())).toMatchObject({ status: 'failed', error: 'native_request_failed' });
 expect(f.sockets[0].sent.some(frame => frame.method === 'sessions.describe')).toBe(true);
 expect(f.sockets[0].sent.filter(frame => frame.method === 'sessions.patch')).toHaveLength(0);
});

it('re-reads the same Native model directory before submission instead of freezing browse availability', async () => {
 const f = await fixture();
 const catalog = (await f.command('models-before-change', { capabilityId: 'model.set' })).catalog!;
 f.native.models = { models: [] };
 expect((await f.invoke('model-removed', { capabilityId: 'model.set', catalogVersion: catalog.version, parameters: { providerId: 'provider-c', modelId: 'model-c' } })).status).toBe('failed');
 expect(f.sockets[0].sent.filter(frame => frame.method === 'sessions.patch')).toHaveLength(0);
});

it('rejects a stale model snapshot before patching even when the selected pair still exists', async () => {
 const f = await fixture();
 const browse = async (id: string) => (await f.command(id, { capabilityId: 'model.set' })).catalog!;
 const shown = await browse('models-shown');
 f.native.models = { models: [{ provider: 'provider-c', id: 'model-c', name: 'Model C', available: false }, { provider: 'provider-d', id: 'model-d', name: 'Model D', available: false }] };
 const selection = { capabilityId: 'model.set', parameters: { providerId: 'provider-c', modelId: 'model-c' } };
 expect(await f.invoke('stale-model-snapshot', { ...selection, catalogVersion: shown.version })).toMatchObject({ status: 'failed', error: 'catalog_stale' });
 expect(f.sockets[0].sent.filter(frame => frame.method === 'sessions.patch')).toHaveLength(0);
 const refreshed = await browse('models-refreshed');
 expect(refreshed.version).not.toBe(shown.version);
 expect(await f.invoke('fresh-model-snapshot', { ...selection, catalogVersion: refreshed.version })).toMatchObject({ status: 'completed', effect: { kind: 'model', modelId: 'model-c', effective: 'next_request' } });
 expect(f.sockets[0].sent.filter(frame => frame.method === 'sessions.patch')).toHaveLength(1);
});

it('does not use a prior connection model snapshot after reconnect', async () => {
 const f = await fixture(), choice = await f.modelChoice();
 await f.driver.disconnect(); await f.driver.connect();
 expect(await f.invoke('old-connection-model', choice)).toMatchObject({ status: 'failed', error: 'catalog_stale' });
 expect(f.sockets[1].sent.filter(frame => frame.method === 'models.list' || frame.method === 'sessions.patch')).toEqual([]);
 const fresh = (await f.command('model-after-reconnect', { capabilityId: 'model.set' })).catalog!;
 expect(fresh.version).not.toBe(choice.catalogVersion);
 expect(await f.invoke('new-connection-model', { ...choice, catalogVersion: fresh.version })).toMatchObject({ status: 'completed', effect: { kind: 'model', effective: 'next_request' } });
 expect(f.sockets[1].sent.filter(frame => frame.method === 'sessions.patch')).toHaveLength(1);
});

it('does not let a failed or hanging model browse block session controls', async () => {
 const f = await fixture(); f.native.modelErrorCode = 'UNAVAILABLE';
 expect((await f.command('models-unavailable', { capabilityId: 'model.set' })).catalog?.models).toBeUndefined();
 f.native.modelErrorCode = undefined; f.native.dropModels = true;
 const socket = f.sockets[0];
 const modelRequests = () => socket.sent.filter(frame => frame.method === 'models.list');
 let browseSettled = false;
 const pending = f.command('models-hanging', { capabilityId: 'model.set' }).then(receipt => {
  browseSettled = true; return receipt;
 });
 try {
  await waitFor(() => expect(modelRequests()).toHaveLength(2));
  expect((await f.command('controls-with-models-hung')).catalog!.version).toBe(f.catalog.version);
  expect((await f.invoke('compact-with-models-hung')).status).toBe('completed');
  expect(browseSettled).toBe(false);
  expect(modelRequests()).toHaveLength(2);
 } finally {
  const dropped = modelRequests()[1];
  if (dropped) socket.reply(dropped.id, f.native.models);
  await pending;
 }
 expect((await pending).catalog?.models?.total).toBe(2);
});

it.each(['FORBIDDEN', 'INVALID_REQUEST'])('preserves definitive Native model refusal without inventing a selection: %s', async code => {
 const f = await fixture(), before = f.store.get('1', '2')!.selectedModel; f.native.patchErrorCode = code;
 const patch = await f.modelChoice();
 expect((await f.invoke('model-denied', patch)).status).toBe('failed');
 expect((await f.invoke('model-denied', { ...patch, reconcileOnly: true })).status).toBe('failed');
 expect(f.native.selectedModel).toBeUndefined(); expect(f.store.get('1', '2')!.selectedModel).toEqual(before);
 expect(f.sockets[0].sent.filter(frame => frame.method === 'sessions.patch')).toHaveLength(1);
});

it.each(['empty-ack', 'wrong-key', 'missing-entry', 'new-session', 'wrong-provider', 'wrong-model', 'malformed-error-code'])('keeps unproven Native model results unknown with no replay: %s', async fault => {
 const f = await fixture(), before = f.store.get('1', '2')!.selectedModel;
 const payload = { ok: true, key: f.canonicalK, entry: { sessionId: 'native-session-old' }, resolved: { modelProvider: 'provider-c', model: 'model-c' } };
 if (fault === 'wrong-key') payload.key = 'other-session';
 if (fault === 'new-session') payload.entry.sessionId = 'minted-session';
 if (fault === 'wrong-provider') payload.resolved.modelProvider = 'provider-other';
 if (fault === 'wrong-model') payload.resolved.model = 'other-model';
 if (fault === 'malformed-error-code') f.native.patchErrorCode = 'INVALID_REQUEST]extra';
 f.native.modelPayload = fault === 'empty-ack' ? {} : fault === 'missing-entry' ? { ...payload, entry: undefined } : payload;
 const patch = await f.modelChoice();
 const receipt = await f.invoke('model-unproven', patch); expect(receipt.status).toBe('unknown'); expect(receipt.effect).toBeUndefined();
 expect((await f.invoke('model-unproven', { ...patch, reconcileOnly: true })).status).toBe('unknown');
 expect(f.store.get('1', '2')!.selectedModel).toEqual(before);
 expect(f.sockets[0].sent.filter(frame => frame.method === 'sessions.patch')).toHaveLength(1);
});

it.each([
 { change: 'epoch', when: 'before' }, { change: 'epoch', when: 'after' },
 { change: 'generation', when: 'before' }, { change: 'generation', when: 'after' },
 { change: 'socket', when: 'before' }, { change: 'socket', when: 'after' },
])('fences model selection across $change changes $when Native mutation', async ({ change, when }) => {
 const f = await fixture(), before = f.store.get('1', '2')!.selectedModel;
 const invalidate = async () => {
  if (change === 'epoch') await f.setEpoch('revoked');
  if (change === 'generation') f.store.reset('1', '2');
  if (change === 'socket') { await f.driver.disconnect(); await f.driver.connect(); }
 };
 if (when === 'before') f.native.beforeResolve = invalidate; else f.native.afterPatch = invalidate;
 const patch = await f.modelChoice();
 expect((await f.invoke('model-invalidated', patch)).status).toBe(when === 'before' ? 'failed' : 'unknown');
 // A new authorization epoch cannot replay the old epoch's journal fingerprint.
 expect((await f.invoke('model-invalidated', { ...patch, reconcileOnly: true })).status).toBe(change === 'epoch' ? 'unknown' : when === 'before' ? 'failed' : 'unknown');
 expect(f.store.get('1', '2')!.selectedModel).toEqual(before);
 expect(f.sockets.flatMap(socket => socket.sent).filter(frame => frame.method === 'sessions.patch')).toHaveLength(when === 'before' ? 0 : 1);
});

it('retains a model side effect without response as unknown and never repeats it', async () => {
 const f = await fixture(), choice = await f.modelChoice(); f.native.dropPatch = true;
 vi.useFakeTimers();
 f.handler.handle({ type: 'agentCommand', data: { requestId: 'model-timeout', roomId: '2', aiclawUid: '1', operation: 'invoke', ...choice,
  context: { roomType: 2, counterpartUid: 'owner', isOwner: true, authorizationEpoch: 'epoch' } } });
 await vi.advanceTimersByTimeAsync(15_001);
 expect(f.store.getControl('1', '2', 'model-timeout')?.receipt?.status).toBe('unknown');
 expect((await f.invoke('model-timeout', { ...choice, reconcileOnly: true })).status).toBe('unknown');
 expect(f.native.selectedModel).toBe('provider-c/model-c');
 expect(f.sockets[0].sent.filter(frame => frame.method === 'sessions.patch')).toHaveLength(1);
});

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
 'does not infer control authority from an otherwise connected gateway: %j', async options => {
  const f = await fixture(options);
  expect(f.catalog.capabilities.some(capability => ['session.compact', 'model.set'].includes(capability.id) && capability.executable)).toBe(false);
  expect(await f.command('browse-no-authority', { capabilityId: 'model.set' })).toMatchObject({
   status: 'completed', catalog: { version: 'unavailable', capabilities: [] },
  });
  expect(await f.invoke('compact-no-authority')).toMatchObject({ status: 'failed', error: 'native_request_failed' });
  expect(await f.invoke('model-no-authority', {
   capabilityId: 'model.set', catalogVersion: `openclaw-models:${'0'.repeat(64)}:${'1'.repeat(64)}`,
   parameters: { providerId: 'provider-c', modelId: 'model-c' },
  })).toMatchObject({ status: 'failed', error: 'native_request_failed' });
  expect(f.sockets[0].sent.filter(frame => frame.method === 'models.list' || frame.method.startsWith('sessions.'))).toEqual([]);
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
 const f = await fixture(), choice = await f.modelChoice();
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
 expect(await f.invoke('model-active', choice)).toMatchObject({ status: 'completed', effect: { kind: 'model', effective: 'next_request' } });
 expect(f.store.get('1', '2')).toMatchObject({ generation: before.generation, contextKey: before.contextKey, selectedModel: before.selectedModel, pendingRuns: before.pendingRuns, replyBindings: before.replyBindings });
 expect(f.sockets[0].sent.filter(frame => !['connect', 'aichat.gatewayContext', 'agent', 'sessions.resolve', 'sessions.describe', 'sessions.compact', 'models.list', 'sessions.patch'].includes(frame.method))).toHaveLength(0);
 expect(f.sockets[0].sent.filter(frame => frame.method === 'agent')).toHaveLength(1);
 expect(f.hula.frames.filter(frame => frame.type === WSReqType.THINKING_START)).toHaveLength(1);
 f.sockets[0].emit('message', Buffer.from(JSON.stringify({ type: 'event', event: 'agent', payload: { runId: 'ordinary-native-run', seq: 1, stream: 'lifecycle', ts: Date.now(), data: { phase: 'end' } } })));
 await waitFor(() => expect(f.store.pendingRuns()).toHaveLength(0));
});
