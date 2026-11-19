import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi, describe } from 'vitest';
import type WebSocket from 'ws';
import { OpenclawDriver } from './openclaw-driver.js';
import { readOpenclawRunBindFile } from './run-bind.js';
import { ConversationStore } from '../../capability/conversations.js';
import { MessageHandler } from '../../handler/message.js';
import type { HulaWSClient } from '../../server/hula-ws.js';
import type { HulaApiClient } from '../../api/hula-api.js';
import type { AgentCommandResponse } from '../../stream/protocol.js';
import register from '../../../../claw/src/index.js';
import type { OpenClawPluginApi } from '../../../../claw/src/types.js';

const faults = vi.hoisted(() => ({ metadataWrites: 0, afterObservationRead: undefined as undefined | (() => void), afterOriginalRead: undefined as undefined | (() => Promise<void>) }));
vi.mock('node:fs/promises', async importOriginal => {
 const fs = await importOriginal<typeof import('node:fs/promises')>();
 return { ...fs,
  readFile: async (...args: Parameters<typeof fs.readFile>) => { const value = await fs.readFile(...args); if (String(args[0]).endsWith('native-run-1.json') && faults.afterOriginalRead) { const callback = faults.afterOriginalRead; faults.afterOriginalRead = undefined; await callback(); } return value; },
  writeFile: async (...args: Parameters<typeof fs.writeFile>) => { if (/\.context\.json|\.conflict/.test(String(args[0]))) faults.metadataWrites++; return fs.writeFile(...args); },
 };
});

const waitFor = <T>(check: () => T | Promise<T>) => vi.waitFor(check, { timeout: 3000 });
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { faults.metadataWrites = 0; faults.afterObservationRead = undefined; faults.afterOriginalRead = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(options: { hook?: boolean; version?: string; protocol?: number; earlyHook?: boolean; start?: boolean; observer?: 'pending' | 'missing' | 'denied' } = {}) {
 const home = await mkdtemp(join(tmpdir(), 'openclaw-catalog-')), bindDir = join(home, 'run-bind'), nativeWorkspace = join(home, 'native-agent-workspace');
 vi.stubEnv('AICHAT_OPENCLAW_RUNBIND_DIR', bindDir);
 const hooks = new Map<string, (event: unknown, context: unknown) => unknown>();
 type GatewayHandler = (args: { params: Record<string, unknown>; respond: (ok: boolean, value?: unknown, error?: unknown) => void }) => void;
 const gatewayMethods = new Map<string, { handler: GatewayHandler; scope: string }>();
 const namespaces = new Map<string, unknown>();
 const subscriptions: Array<(event: { runId: string; stream: string; data: Record<string, unknown> }) => void> = [];
 const closedRuns = new Set<string>();
 let refusedWrites = 0;
 const registerPlugin = () => {
 let retired = false;
 register({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, registerChannel: vi.fn(),
  on: (name: string, hook: (event: unknown, context: unknown) => unknown) => hooks.set(name, hook),
  runContext: {
   getRunContext: (params: { runId: string; namespace: string }) => structuredClone(namespaces.get(JSON.stringify([params.runId, params.namespace]))),
   // Pinned registry facade: a retired registration refuses writes while reads remain visible.
   setRunContext: (patch: { runId: string; namespace: string; value: unknown }) => { if (retired || closedRuns.has(patch.runId)) { refusedWrites++; return false; } namespaces.set(JSON.stringify([patch.runId, patch.namespace]), structuredClone(patch.value)); return true; },
  },
  registerGatewayMethod: (method: string, handler: GatewayHandler, opts: { scope: string }) => gatewayMethods.set(method, { handler, scope: opts.scope }),
  agent: { events: { registerAgentEventSubscription: (subscription: { handle: typeof subscriptions[number] }) => subscriptions.push(subscription.handle) } },
 } as unknown as OpenClawPluginApi);
 return { retire: () => { retired = true; } };
 };
 let registration = registerPlugin();
 const terminalOnly = (runId: string, clear = false) => {
  for (const handle of subscriptions) handle({ runId, stream: 'lifecycle', data: { phase: 'end' } });
  closedRuns.add(runId);
  if (clear) for (const key of namespaces.keys()) if (JSON.parse(key)[0] === runId) namespaces.delete(key);
 };
 let nativeSequence = 0;
 class Socket extends EventEmitter {
  readonly sent: Array<{ id: string; method: string; params: Record<string, unknown> }> = [];
  nativeKey = ''; nativeRunId = ''; observerReply?: () => void;
  earlyHook?: Promise<unknown>;
  denied = new Set<string>();
  overrides = new Map<string, unknown>();
  transform?: (method: string, payload: unknown) => unknown;
  send(data: string) {
   const frame = JSON.parse(data); this.sent.push(frame);
   queueMicrotask(() => {
    let payload: unknown;
    if (frame.method === 'aichat.gatewayContext') {
     const method = gatewayMethods.get(frame.method);
     const respond = (ok: boolean, value?: unknown, error?: unknown) => {
      const deliver = () => { this.emit('message', Buffer.from(JSON.stringify({ type: 'res', id: frame.id, ok, payload: value, error }))); if (frame.params.kind === 'context' && faults.afterObservationRead) { const callback = faults.afterObservationRead; faults.afterObservationRead = undefined; callback(); } };
      if (frame.params.kind === 'observer' && options.observer === 'pending' && this === sockets[0]) this.observerReply = deliver; else deliver();
     };
     if (this.denied.has(frame.method) || !method || (frame.params.kind === 'observer' && ['missing', 'denied'].includes(options.observer ?? ''))) respond(false, undefined, { code: options.observer === 'missing' ? 'NOT_FOUND' : 'FORBIDDEN' });
     else { expect(method.scope).toBe('operator.read'); method.handler({ params: frame.params, respond }); }
     return;
    }
    if (frame.method === 'connect') payload = { type: 'hello-ok', protocol: options.protocol ?? 4, server: { version: options.version ?? '2026.6.5', connId: 'catalog-connection' }, auth: { role: 'operator', scopes: ['operator.read', 'operator.write'] } };
    if (frame.method === 'agent') {
      this.nativeKey = 'agent:native-a:' + frame.params.sessionKey; this.nativeRunId = 'native-run-' + (++nativeSequence); payload = { status: 'accepted', runId: this.nativeRunId };
      if (options.earlyHook) {
       this.earlyHook = Promise.resolve(hooks.get('before_prompt_build')!(undefined, { runId: this.nativeRunId, agentId: 'native-a', sessionKey: this.nativeKey, sessionId: 'native-session-1', workspaceDir: nativeWorkspace }));
       setTimeout(() => this.emit('message', Buffer.from(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload }))), 20); return;
      }
     }
    if (frame.method === 'sessions.resolve') payload = { ok: true, key: this.nativeKey };
    if (frame.method === 'sessions.describe') payload = { session: { key: this.nativeKey, sessionId: 'native-session-1' } };
    if (frame.method === 'agent.identity.get') payload = { agentId: 'native-a', name: 'Native A' };
    if (frame.method === 'agents.files.list') payload = { agentId: 'native-a', workspace: nativeWorkspace, files: [] };
    if (frame.method === 'commands.list') payload = { commands: [
     { name: 'probe', description: 'Native eligible skill', source: 'skill', scope: 'text', textAliases: ['/probe'], acceptsArgs: true, args: [{ name: 'input', description: 'Literal input', type: 'string' }] },
     { name: 'help', description: 'Not a skill', source: 'native', scope: 'both', textAliases: ['/help'], acceptsArgs: false },
    ] };
    if (this.denied.has(frame.method)) { this.emit('message', Buffer.from(JSON.stringify({ type: 'res', id: frame.id, ok: false, error: { code: 'FORBIDDEN', message: 'secret native details must not leak' } }))); return; }
     if (this.overrides.has(frame.method)) payload = this.overrides.get(frame.method);
     payload = this.transform ? this.transform(frame.method, payload) : payload;
     if (payload !== undefined) this.emit('message', Buffer.from(JSON.stringify({ type: 'res', id: frame.id, ok: true, payload })));
   });
  }
  close() { this.emit('close', 1000, Buffer.from('test')); }
  end() { this.emit('message', Buffer.from(JSON.stringify({ type: 'event', event: 'agent', payload: { runId: this.nativeRunId, seq: 1, stream: 'lifecycle', ts: Date.now(), data: { phase: 'end' } } }))); }
 }
 const sockets: Socket[] = [];
 const factory = () => { const socket = new Socket(); sockets.push(socket); queueMicrotask(() => { socket.emit('open'); socket.emit('message', Buffer.from(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'challenge' } }))); }); return socket as unknown as WebSocket; };
 const driver = new OpenclawDriver('ws://fake.invalid', '', factory, home, undefined, bindDir);
 const store = new ConversationStore({ home, serverNamespace: 'server', activeUids: new Set(['1']), activeProviders: new Map([['1', 'openclaw']]) });
 let handler!: MessageHandler; let currentEpoch = 'epoch';
 const frames: Array<{ type: number; data: Record<string, unknown> }> = [], receipts: AgentCommandResponse[] = [];
 const send = (type: number, data: Record<string, unknown>) => { frames.push({ type, data }); if (type === 20) queueMicrotask(() => handler.handle({ type: 'thinkingStart', data: { ...data, fromUid: '1', thinkingId: 'thinking-' + data.clientRunId } })); };
 handler = new MessageHandler({ send, isConnected: true } as unknown as HulaWSClient, driver, '1', { reportAgentCommandResult: async (receipt: AgentCommandResponse) => { receipts.push(receipt); }, listSelfGroupConfigs: async () => [{ roomId: '2', approved: 1, authorizationEpoch: currentEpoch }] } as unknown as HulaApiClient, { waitMs: 1, maxWaitMs: 1 }, () => {}, () => store, home);
 cleanup.push(async () => { handler.destroy(); await driver.disconnect(); store.close(); await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
 await driver.connect(); await handler.prewarmGroupConfigs();
 const socket = sockets[0];
 const ordinary = (id = 'original-input') => handler.handle({ type: 'receiveMessage', data: { fromUser: { uid: 'owner', name: 'Owner', userType: 1 }, message: { id, roomId: '2', roomType: 2, type: 1, aiclaw: { isOwner: true }, body: { content: 'ordinary original message' } } } });
 if (options.start !== false) {
  ordinary();
  await waitFor(async () => expect(await readOpenclawRunBindFile(bindDir, 'native-run-1')).toBeDefined());
 }
 const context = { runId: 'native-run-1', agentId: 'native-a', sessionKey: socket.nativeKey, sessionId: 'native-session-1', workspaceDir: nativeWorkspace, modelProviderId: 'provider-a', modelId: 'model-a' };
 const originalBinding = await readOpenclawRunBindFile(bindDir, 'native-run-1');
 const event = new Proxy({}, { get: () => { throw new Error('Prompt event must never be inspected'); } });
 if (options.earlyHook) await socket.earlyHook;
 else if (options.start !== false && options.hook !== false) await hooks.get('before_prompt_build')?.(event, context);
 const discover = async (requestId: string, patch: Record<string, unknown> = {}) => { handler.handle({ type: 'agentCommand', data: { requestId, roomId: '2', aiclawUid: '1', operation: 'discover', context: { roomType: 2, counterpartUid: 'owner', isOwner: true, authorizationEpoch: currentEpoch }, ...patch } }); await waitFor(() => expect(receipts.find(r => r.requestId === requestId)).toBeDefined()); return receipts.find(r => r.requestId === requestId)!; };
 return { home, bindDir, nativeWorkspace, driver, store, socket, sockets, hooks, frames, context, originalBinding, discover, handler, ordinary,
   retire: () => registration.retire(),
   reload: () => { registration.retire(); subscriptions.splice(0); registration = registerPlugin(); },
   terminalOnly, refusedWrites: () => refusedWrites,
   observation: () => structuredClone([...namespaces.values()][0]) as Record<string, unknown> | undefined,
  setEpoch: async (epoch: string) => { currentEpoch = epoch; await handler.prewarmGroupConfigs(); } };
}

it('never submits a prepared original owner on a replacement transport', async () => {
 const f = await fixture({ start: false });
 let entered = false, release!: () => void; const paused = new Promise<void>(resolve => { release = resolve; });
 const create = f.driver.createRun.bind(f.driver);
 vi.spyOn(f.driver, 'createRun').mockImplementation(input => {
  const save = input.saveRecovery;
  input.saveRecovery = async value => { await save(value); entered = true; await paused; };
  return create(input);
 });
 f.ordinary(); await waitFor(() => expect(entered).toBe(true));
 try {
  f.socket.close();
  await waitFor(() => { expect(f.sockets).toHaveLength(2); expect(f.driver.isConnected).toBe(true); });
  release();
  const submissions = () => f.sockets.flatMap(socket => socket.sent).filter(frame => frame.method === 'agent');
  await waitFor(() => expect(submissions().length + f.frames.filter(frame => frame.type === 22).length).toBeGreaterThan(0));
  if (submissions().length) f.sockets[1].end();
  await waitFor(() => expect(f.frames.filter(frame => frame.type === 22)).toHaveLength(1));
  expect(submissions()).toHaveLength(0);
  expect(f.frames.find(frame => frame.type === 22)!.data.status).toBe('error');
   expect(f.store.get('1', '2')!.state).toBe('stop_unconfirmed');
   expect(f.driver.createRun).toHaveBeenCalledTimes(1);
 } finally { release(); }
});

it('uses SDK runContext through one read method without metadata filesystem writes', async () => {
 const f = await fixture();
 const receipt = await f.discover('sdk-catalog');
 expect(receipt.catalog!.discovery?.coverage).toBe('complete');
 expect(f.socket.sent.filter(frame => frame.method === 'aichat.gatewayContext' && frame.params.kind === 'observer')).toHaveLength(1);
 expect(f.socket.sent.some(frame => frame.method === 'aichat.gatewayContext' && frame.params.kind === 'context')).toBe(true);
 expect(faults.metadataWrites).toBe(0);
 expect(await readOpenclawRunBindFile(f.bindDir, 'native-run-1')).toEqual(f.originalBinding);
});

it.each(['pending', 'missing', 'denied'] as const)('keeps ordinary independent of an observer %s result and never fills its old stamp', async observer => {
 const f = await fixture({ observer });
 expect(f.socket.sent.filter(frame => frame.method === 'agent')).toHaveLength(1);
 expect(f.frames.filter(frame => frame.type === 20)).toHaveLength(1);
 expect((await f.discover('unavailable-observer')).catalog!.discovery?.coverage).toBe('unavailable');
 f.socket.observerReply?.();
 expect((await f.discover('late-observer-not-filled')).catalog!.discovery?.coverage).toBe('unavailable');
 expect(f.socket.sent.filter(frame => frame.method === 'aichat.gatewayContext' && frame.params.kind === 'observer')).toHaveLength(1);
 expect(faults.metadataWrites).toBe(0);
});

it('does not refresh same-WS reload for later owners; only a naturally new socket gets its new observer', async () => {
 const f = await fixture();
 f.reload(); f.socket.end();
 await waitFor(async () => expect(await readOpenclawRunBindFile(f.bindDir, 'native-run-1')).toBeUndefined());
 f.ordinary('same-ws-B');
 await waitFor(async () => expect(await readOpenclawRunBindFile(f.bindDir, 'native-run-2')).toBeDefined());
 await f.hooks.get('before_prompt_build')!(undefined, { ...f.context, runId: 'native-run-2', sessionKey: f.socket.nativeKey });
 expect((await f.discover('same-ws-new-owner')).catalog!.discovery?.coverage).toBe('unavailable');
 expect(f.socket.sent.filter(frame => frame.method === 'aichat.gatewayContext' && frame.params.kind === 'observer')).toHaveLength(1);
 f.socket.end(); await waitFor(async () => expect(await readOpenclawRunBindFile(f.bindDir, 'native-run-2')).toBeUndefined());
 f.socket.close(); await waitFor(() => { expect(f.sockets).toHaveLength(2); expect(f.driver.isConnected).toBe(true); });
 f.ordinary('new-ws-C');
 await waitFor(async () => expect(await readOpenclawRunBindFile(f.bindDir, 'native-run-3')).toBeDefined());
 await f.hooks.get('before_prompt_build')!(undefined, { ...f.context, runId: 'native-run-3', sessionKey: f.sockets[1].nativeKey });
 expect((await f.discover('natural-new-ws-owner')).catalog!.discovery?.coverage).toBe('complete');
 expect(faults.metadataWrites).toBe(0);
});

it('ignores an old socket observer response after a replacement is ready', async () => {
 const f = await fixture({ observer: 'pending' });
 f.socket.end(); await waitFor(async () => expect(await readOpenclawRunBindFile(f.bindDir, 'native-run-1')).toBeUndefined());
 f.reload(); f.socket.close();
 await waitFor(() => { expect(f.sockets).toHaveLength(2); expect(f.driver.isConnected).toBe(true); });
 f.ordinary('replacement-owner');
 await waitFor(async () => expect(await readOpenclawRunBindFile(f.bindDir, 'native-run-2')).toBeDefined());
 await f.hooks.get('before_prompt_build')!(undefined, { ...f.context, runId: 'native-run-2', sessionKey: f.sockets[1].nativeKey });
 expect((await f.discover('replacement-before-old')).catalog!.discovery?.coverage).toBe('complete');
 f.socket.observerReply!();
 expect((await f.discover('replacement-after-old')).catalog!.discovery?.coverage).toBe('complete');
 expect(f.sockets[1].sent.filter(frame => frame.method === 'aichat.gatewayContext' && frame.params.kind === 'observer')).toHaveLength(1);
});

it('rejects a canonical native workspace that changes one-way across commands.list', async () => {
 const f = await fixture();
 f.socket.transform = (method, payload) => { if (method === 'commands.list') f.socket.overrides.set('agents.files.list', { agentId: 'native-a', workspace: join(f.home, 'native-W2'), files: [] }); return payload; };
 expect((await f.discover('one-way-native-W')).catalog!.discovery?.coverage).toBe('unavailable');
 expect(f.socket.sent.filter(frame => frame.method === 'commands.list')).toHaveLength(1);
});

describe('catalog native boundaries', () => {
 it.each(['missing-run', 'agentId', 'sessionKey', 'sessionId', 'workspaceDir'])('refuses unproved native metadata %s', async field => {
  const f = await fixture({ hook: false });
  const context = { ...f.context, ...(field === 'missing-run' ? { runId: undefined } : { [field]: field === 'workspaceDir' ? join(f.home, 'ui-W2') : 'foreign-' + field }) };
  await f.hooks.get('before_prompt_build')!(undefined, context);
  const receipt = await f.discover('untrusted');
  expect(receipt.catalog!.discovery?.coverage).toBe('unavailable');
  expect(receipt.catalog!.capabilities).toEqual([]);
  expect(f.socket.sent.filter(r => r.method === 'commands.list')).toHaveLength(0);
 });
 it.each(['sessions.resolve', 'sessions.describe', 'agent.identity.get', 'agents.files.list', 'commands.list'])('reports native permission denial honestly for %s', async method => {
  const f = await fixture(); f.socket.denied.add(method);
  const receipt = await f.discover('denied');
  expect(receipt.catalog!.discovery).toEqual({ source: 'native', coverage: 'unavailable', reason: 'native_unavailable' });
  expect(JSON.stringify(receipt)).not.toContain('secret native details');
  expect(await readOpenclawRunBindFile(f.bindDir, 'native-run-1')).toEqual(f.originalBinding);
 });
 it.each([{ version: '2026.6.4' }, { protocol: 3 }])('does not claim unsupported native version/protocol %o', async options => {
  const f = await fixture(options);
  expect((await f.discover('wrong-version')).catalog!.discovery).toEqual({ source: 'native', coverage: 'unavailable', reason: 'native_unavailable' });
  expect(f.socket.sent.filter(r => r.method === 'commands.list')).toHaveLength(0);
 });
 it('marks the native 500 item ceiling partial rather than guessing completeness', async () => {
  const f = await fixture();
  f.socket.overrides.set('commands.list', { commands: Array.from({ length: 500 }, (_, n) => ({ name: 'probe-' + n, description: '', source: 'skill', scope: 'text', textAliases: ['/probe-' + n], acceptsArgs: false })) });
  const receipt = await f.discover('capped');
  expect(receipt.catalog!.discovery).toEqual({ source: 'native', coverage: 'partial', reason: 'native_limit' });
  expect(receipt.catalog!.capabilities).toHaveLength(500); expect(receipt.catalog!.capabilities.every(item => !item.executable)).toBe(true);
 });
 it('filters non-text and non-invocable entries without inventing inventory fields', async () => {
  const f = await fixture();
  f.socket.overrides.set('commands.list', { commands: [
   { name: 'usable', description: '', source: 'skill', scope: 'text', textAliases: ['/usable'], acceptsArgs: false },
   { name: 'native-only', description: '', source: 'skill', scope: 'native', acceptsArgs: false },
   { name: 'no-text-alias', description: '', source: 'skill', scope: 'text', acceptsArgs: false },
   { name: 'plugin-command', description: '', source: 'plugin', scope: 'text', textAliases: ['/plugin'], acceptsArgs: false },
  ] });
  const receipt = await f.discover('eligible');
  expect(receipt.catalog!.discovery?.coverage).toBe('complete'); expect(receipt.catalog!.capabilities.map(item => item.name)).toEqual(['usable']);
 });
  it('omits explicit and implicit slash collisions without hiding unrelated skills', async () => {
   const f = await fixture();
   const longPluginName = 'x'.repeat(200);
   f.socket.overrides.set('commands.list', { commands: [
    { name: 'probe', description: '', source: 'skill', scope: 'both', textAliases: ['/probe', '/pick'], acceptsArgs: true },
    { name: 'plugin-pick', description: '', source: 'plugin', scope: 'both', textAliases: ['/PiCk'], acceptsArgs: false },
    { name: 'implicit', description: '', source: 'skill', scope: 'both', textAliases: ['/different'], acceptsArgs: false },
    { name: 'ImPlIcIt', description: '', source: 'native', scope: 'both', textAliases: ['/native-alias'], acceptsArgs: false },
    { name: longPluginName, description: '', source: 'plugin', scope: 'both', textAliases: [`/${longPluginName}`], acceptsArgs: false },
    { name: 'other', description: '', source: 'skill', scope: 'both', textAliases: ['/other'], acceptsArgs: false },
   ] });
   const originalAgentSubmissions = f.socket.sent.filter(frame => frame.method === 'agent').length;
   expect(originalAgentSubmissions).toBe(1);
   const { catalog } = await f.discover('ambiguous-alias');
   expect(catalog?.discovery?.coverage).toBe('complete');
   expect(catalog?.capabilities.map(item => item.id)).toEqual(['skill:other']);
   expect(f.socket.sent.filter(frame => frame.method === 'agent')).toHaveLength(originalAgentSubmissions);
   expect(f.socket.sent.filter(frame => frame.method === 'chat.send')).toHaveLength(0);
  });
  it('changes the version when native argument choices change', async () => {
  const f = await fixture(); const first = await f.discover('before-args');
  f.socket.transform = (method, payload) => method === 'commands.list' ? { commands: [{ name: 'probe', description: 'Native eligible skill', source: 'skill', scope: 'text', textAliases: ['/probe'], acceptsArgs: true,
   args: [{ name: 'input', description: 'Literal input', type: 'string', choices: [{ value: 'literal', label: 'Literal' }] }] }] } : payload;
  const changed = await f.discover('after-args'); expect(changed.catalog!.discovery?.coverage).toBe('complete'); expect(changed.catalog!.version).not.toBe(first.catalog!.version);
 });
 it('cannot discover a foreign conversation even with an active original run', async () => {
  const f = await fixture();
  expect((await f.discover('foreign-room', { roomId: '3' })).catalog!.discovery?.coverage).toBe('unavailable');
  expect(f.socket.sent.filter(r => r.method === 'commands.list')).toHaveLength(0);
 });
 it('withdraws completed or reset original runs instead of retaining a trusted current workspace', async () => {
  const f = await fixture(); f.socket.end(); await waitFor(() => expect(f.frames.filter(r => r.type === 22)).toHaveLength(1));
  expect((await f.discover('completed-original')).catalog!.discovery?.coverage).toBe('unavailable');
  f.store.reset('1', '2');
  expect((await f.discover('old-generation')).catalog!.discovery?.coverage).toBe('unavailable');
  expect(f.socket.sent.filter(r => r.method === 'commands.list')).toHaveLength(0);
 });
 it('preserves valid-owner discovery while denying stale request epoch and generation', async () => {
  const f = await fixture(); const record = f.store.get('1', '2')!;
  expect(record.generation).toBeGreaterThan(0);
  const context = { roomType: 2, counterpartUid: 'owner', isOwner: true, authorizationEpoch: 'epoch', expectedGeneration: String(record.generation) };
  expect((await f.discover('current-owner', { context })).catalog!.discovery?.coverage).toBe('complete');
  const nativeQueries = f.socket.sent.filter(frame => frame.method === 'commands.list').length;
  for (const [requestId, patch] of [['stale-request-epoch', { authorizationEpoch: 'old-epoch' }], ['stale-request-generation', { expectedGeneration: String(record.generation - 1) }]] as const) {
   const denied = await f.discover(requestId, { context: { ...context, ...patch } });
   expect(denied.catalog!.discovery?.coverage).toBe('unavailable');
   expect(denied.catalog!.capabilities).toEqual([]);
  }
  expect(f.socket.sent.filter(frame => frame.method === 'commands.list')).toHaveLength(nativeQueries);
  expect(f.frames.filter(frame => frame.type === 20)).toHaveLength(1);
 });
 it('rejects original-run metadata after the current identity epoch changes', async () => {
  const f = await fixture(); await f.setEpoch('epoch-2');
  expect((await f.discover('old-run-new-epoch')).catalog!.discovery?.coverage).toBe('unavailable');
  expect(f.socket.sent.filter(r => r.method === 'commands.list')).toHaveLength(0);
 });
 it('does not let a late pending owner A overwrite denial or poison successor B', async () => {
  const f = await fixture({ hook: false });
  let entered = false, release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  faults.afterOriginalRead = async () => { entered = true; await held; };
  const lateA = f.hooks.get('before_prompt_build')!(undefined, f.context);
  await waitFor(() => expect(entered).toBe(true));
  await f.hooks.get('before_prompt_build')!(undefined, { ...f.context, sessionId: 'A-required-session-conflict' });
  expect(f.observation()).toMatchObject({ state: 'deny' });
  try {
   f.socket.end(); await waitFor(async () => expect(await readOpenclawRunBindFile(f.bindDir, 'native-run-1')).toBeUndefined());
   f.ordinary('successor-B');
   await waitFor(async () => { const next = await readOpenclawRunBindFile(f.bindDir, 'native-run-2'); expect(next).toBeDefined(); expect(next!.runId).not.toBe(f.originalBinding!.runId); });
   await f.hooks.get('before_prompt_build')!(undefined, { ...f.context, runId: 'native-run-2', sessionKey: f.socket.nativeKey, modelId: 'B-model' });
   expect((await f.discover('B-before-late-A')).catalog!.discovery?.coverage).toBe('complete');
   release(); await lateA;
   const result = await f.discover('B-after-late-A'); expect(result.catalog!.discovery?.coverage).toBe('complete');
   expect(faults.metadataWrites).toBe(0);
   expect((await readdir(f.bindDir)).some(file => /\.context\.json|\.conflict/.test(file))).toBe(false);
  } finally { release(); await lateA; }
 });
 it('waits for first accepted binding without a prompt-hook ACK cycle', async () => {
  const f = await fixture({ earlyHook: true });
  expect((await f.discover('early-hook')).catalog!.discovery?.coverage).toBe('complete');
  expect(f.socket.sent.filter(r => r.method === 'agent')).toHaveLength(1);
 });
 it('rechecks original generation after the final metadata read await', async () => {
  const f = await fixture();
  f.socket.transform = (method, payload) => { if (method === 'commands.list') faults.afterObservationRead = () => f.store.reset('1', '2'); return payload; };
  expect((await f.discover('reset-during-final-metadata')).catalog!.discovery?.coverage).toBe('unavailable');
 });
 it('rechecks generation after a real in-flight native response', async () => {
  const f = await fixture();
  f.socket.transform = (method, payload) => { if (method === 'commands.list') f.store.reset('1', '2'); return payload; };
  expect((await f.discover('reset-during-read')).catalog!.discovery?.coverage).toBe('unavailable');
 });
 it('does not use a UI workspace argument to select a native owner', async () => {
  const f = await fixture();
  const receipt = await f.discover('ui-W2', { parameters: { workspace: join(f.home, 'ui-W2') } });
  expect(receipt).toMatchObject({ status: 'failed', error: 'invalid_request' });
  expect(f.socket.sent.filter(r => r.method === 'commands.list')).toHaveLength(0);
 });
});

it.each([false, true])('denies a necessary session conflict including actual retired SDK setter refusal=%s', async retired => {
 const f = await fixture();
 expect((await f.discover('first')).catalog!.discovery?.coverage).toBe('complete');
 await f.hooks.get('before_prompt_build')!(undefined, f.context);
 expect((await f.discover('duplicate')).catalog!.discovery?.coverage).toBe('complete');
 if (retired) f.retire();
 await f.hooks.get('before_prompt_build')!(undefined, { ...f.context, sessionId: 'different-required-session' });
 expect((await f.discover('conflict')).catalog!.discovery?.coverage).toBe('unavailable');
 if (retired) expect(f.refusedWrites()).toBe(1);
 expect(faults.metadataWrites).toBe(0);
 await f.hooks.get('before_prompt_build')!(undefined, f.context);
 expect((await f.discover('still-conflicted')).catalog!.discovery?.coverage).toBe('unavailable');
 expect(await readOpenclawRunBindFile(f.bindDir, 'native-run-1')).toEqual(f.originalBinding);
});

it('does not resurrect M0 after a real retired SDK deny failure and same-WS reload', async () => {
 const f = await fixture();
 const before = f.observation();
 expect(before).toMatchObject({ state: 'ready', sessionId: 'native-session-1' });
 f.retire();
 await f.hooks.get('before_prompt_build')!(undefined, { ...f.context, sessionId: 'different-required-session' });
 expect(f.refusedWrites()).toBe(1);
 expect(f.observation()).toEqual(before); // Failed denial really leaves the SDK's old M0 present.
 f.reload();
 await f.hooks.get('before_prompt_build')!(undefined, f.context);
 expect(f.observation()).toEqual(before); // No restamp / fresh-observation laundering.
 expect((await f.discover('reload-after-deny-failure')).catalog!.discovery?.coverage).toBe('unavailable');
 expect(f.socket.sent.filter(frame => frame.method === 'aichat.gatewayContext' && frame.params.kind === 'observer')).toHaveLength(1);
 expect(await readOpenclawRunBindFile(f.bindDir, 'native-run-1')).toEqual(f.originalBinding);
 expect(faults.metadataWrites).toBe(0);
});

it('keeps terminal-cleared namespace unavailable without inventing task completion', async () => {
 const f = await fixture();
 f.terminalOnly('native-run-1', true);
 expect(f.observation()).toBeUndefined();
 expect((await f.discover('terminal-empty')).catalog!.discovery?.coverage).toBe('unavailable');
 expect(f.frames.filter(frame => frame.type === 22)).toHaveLength(0);
 expect(faults.metadataWrites).toBe(0);
});

it('discovers only native-agent skill commands through original hook metadata and the public catalog', async () => {
 const f = await fixture();
 const receipt = await f.discover('catalog');
 expect(receipt).toMatchObject({ status: 'completed', catalog: { framework: 'openclaw', runtimeVersion: '2026.6.5', discovery: { source: 'native', coverage: 'complete' } } });
 expect(f.hooks.has('before_prompt_build')).toBe(true);
 expect(receipt.catalog!.capabilities.map(item => item.name)).toEqual(['probe']);
 expect(receipt.catalog!.capabilities[0]).toMatchObject({ kind: 'skill', executable: false, reason: 'execution_not_connected' });
 expect(f.socket.sent.filter(r => r.method === 'commands.list').map(r => r.params)).toEqual([{ agentId: 'native-a', scope: 'text', includeArgs: true }]);
 expect(await readOpenclawRunBindFile(f.bindDir, 'native-run-1')).toEqual(f.originalBinding);
 expect(JSON.stringify(receipt.catalog)).not.toContain(f.nativeWorkspace);
 const again = await f.discover('catalog-again'); expect(again.catalog!.version).toBe(receipt.catalog!.version);
 f.socket.end(); await waitFor(() => expect(f.frames.filter(frame => frame.type === 22)).toHaveLength(1));
});
