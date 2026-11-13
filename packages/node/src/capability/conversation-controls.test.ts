import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore } from './conversations.js';
import { CapabilityEndpoint } from './endpoint.js';
import { CapabilityRegistry, type CapabilityContext } from './registry.js';
import type { HulaApiClient } from '../api/hula-api.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
 const home = mkdtempSync(join(tmpdir(), 'control-store-')); roots.push(home);
 const opts = { home, serverNamespace: 'test', activeUids: new Set(['u']), activeProviders: new Map([['u', 'opencode']]) };
 return { store: new ConversationStore(opts), opts, home };
}
describe('native control persistence', () => {
 it('permits only an exact retired reply token to settle old thinking; old alias cannot authorize other capabilities', async () => {
  const { store, home } = fixture();
  store.registerNative('opencode', 'old', 'u', 'r', { sessionID: 'old', directory: home });
  const old = store.beginRun('u', 'r', 'old-run', { authorizationEpoch: 'epoch' });
  store.confirmReplyBindingThinking('old-run', 'old-thinking');
  store.replaceNativeSession('u', 'r', 1, 'opencode', 'new', { sessionID: 'new', directory: home });
  const observed: CapabilityContext[] = [];
  const registry = new CapabilityRegistry();
  registry.register('send-message', async (ctx) => { observed.push(ctx); return { msgId: '123' }; });
  registry.register('find-friend', async (ctx) => { observed.push(ctx); return {}; });
  const bound = (r: ReturnType<ConversationStore['get']>) => r && ({ aiclawUid: r.identityId, roomId: r.roomId,
   apiClient: {} as HulaApiClient, conversationId: r.conversationId, generation: r.generation });
  const endpoint = new CapabilityEndpoint({ registry, serverNamespace: 'test', resolve: () => undefined,
   resolveCandidate: (c) => bound(store.resolveCandidate(c)), resolveReplyContext: (token, candidates) => bound(store.resolveReplyContext(token, candidates)),
   resolveReplyBinding: (token) => { const b = store.resolveReplyBinding(token); return b?.thinkingId ? { ...b, thinkingId: b.thinkingId } : undefined; },
  });
  const request = { version: 3, contexts: [{ provider: 'opencode', nativeId: 'old' }], runBinding: old.replyToken, command: 'send-message', args: { content: 'old completion' }, requestId: 'reply-old' };
  expect((await endpoint.handle({ body: request })).status).toBe(200);
  expect(observed[0]).toMatchObject({ generation: 1, replyThinkingId: 'old-thinking', roomId: 'r' });
  expect((await endpoint.handle({ body: { ...request, command: 'find-friend' } })).status).not.toBe(200);
  expect(observed).toHaveLength(1);
 });
 it('keeps mutation tombstones across restart and permits exactly one strong unknown reconciliation', () => {
  const { store, opts } = fixture();
  expect(store.prepareControl('u', 'r', 'request', 'fingerprint', 'epoch').fresh).toBe(true);
  store.submitControl('u', 'r', 'request', { sessionId: 's', inputId: 'm' });
  store.recordControl('u', 'r', 'request', { status: 'unknown', generation: '1', nativeRef: { sessionId: 's', inputId: 'm' } });
  const reopened = new ConversationStore(opts);
  expect(reopened.prepareControl('u', 'r', 'request', 'fingerprint', 'epoch')).toMatchObject({ fresh: false, entry: { receipt: { status: 'unknown' } } });
  expect(() => reopened.prepareControl('u', 'r', 'request', 'changed', 'epoch')).toThrow('conflict');
  expect(() => reopened.recordControl('u', 'r', 'request', { status: 'completed', reconciled: true, generation: '1', nativeRef: { sessionId: 'other' } })).toThrow('conflict');
  reopened.recordControl('u', 'r', 'request', { status: 'completed', reconciled: true, generation: '1', nativeRef: { sessionId: 's', inputId: 'm', messageId: 'a', parentId: 'm' } });
  expect(reopened.recordControl('u', 'r', 'request', { status: 'failed' }).status).toBe('completed');
 });
 it('atomically checks an optional model snapshot while preserving legacy reset calls', () => {
  const { store, home, opts } = fixture();
  store.registerNative('opencode', 'old', 'u', 'r', { sessionID: 'old', directory: home });
  store.replaceNativeSession('u', 'r', 1, 'opencode', 'none', { sessionID: 'none', directory: home }, null);
  store.selectModel('u', 'r', 2, { providerID: 'provider', modelID: 'B' });
  const before = store.get('u', 'r');
  for (const expected of [null, { providerID: 'provider', modelID: 'A' }, { providerID: 'other', modelID: 'B' }]) {
   expect(() => store.replaceNativeSession('u', 'r', 2, 'opencode', 'conflict', { sessionID: 'conflict', directory: home }, expected)).toThrow('MODEL_SELECTION_CONFLICT');
   expect(store.get('u', 'r')).toEqual(before);
  }
  const reopened = new ConversationStore(opts); expect(reopened.get('u', 'r')).toEqual(before); reopened.close();
  store.replaceNativeSession('u', 'r', 2, 'opencode', 'matching', { sessionID: 'matching', directory: home }, { providerID: 'provider', modelID: 'B' });
  expect(() => store.replaceNativeSession('u', 'r', 2, 'opencode', 'stale', { sessionID: 'stale', directory: home }, { providerID: 'provider', modelID: 'B' })).toThrow('STALE');
  store.replaceNativeSession('u', 'r', 3, 'opencode', 'legacy', { sessionID: 'legacy', directory: home });
  expect(store.get('u', 'r')).toMatchObject({ generation: 4, selectedModel: { providerID: 'provider', modelID: 'B' } });
 });
 it('native reset retains exact old settlement but old completion cannot change new generation', () => {
  const { store, home } = fixture();
  store.registerNative('opencode', 'old', 'u', 'r', { sessionID: 'old', directory: home });
  const old = store.beginRun('u', 'r', 'run-old', { authorizationEpoch: 'epoch' });
  store.confirmReplyBindingThinking('run-old', 'thinking-old');
  old.saveRecovery({ version: 1, value: { provider: 'opencode', sessionID: 'old', directory: home } });
  store.replaceNativeSession('u', 'r', 1, 'opencode', 'new', { sessionID: 'new', directory: home });
  expect(store.get('u', 'r')).toMatchObject({ generation: 2, state: 'ready' });
  expect(store.resolveReplyBinding(old.replyToken)).toMatchObject({ thinkingId: 'thinking-old', generation: 1 });
  expect(store.resolveReplyContext(old.replyToken, [{ provider: 'opencode', nativeId: 'old' }])).toMatchObject({ generation: 1, roomId: 'r' });
  expect(store.resolveCandidate({ provider: 'opencode', nativeId: 'old' })).toBeUndefined();
  const current = store.beginRun('u', 'r', 'run-new');
  expect(() => old.assertCurrent()).toThrow('STALE');
  store.finishRun('run-old');
  expect(store.get('u', 'r')).toMatchObject({ generation: 2, state: 'ready', nativeState: { opencode: { sessionID: 'new' } } });
  expect(() => current.assertCurrent()).not.toThrow();
  expect(() => store.replaceNativeSession('u', 'r', 1, 'opencode', 'orphan', { sessionID: 'orphan', directory: home })).toThrow('STALE');
 });
});
