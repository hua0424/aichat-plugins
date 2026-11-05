import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpencodeDriver } from './opencode-driver.js';
import type { OpencodeServerManager } from './server-manager.js';
import type { CapabilityExecution, PreparedRun, AgentEvent } from '../events.js';
import { readInput } from './input-bind.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));
export function fixture() {
 const root = mkdtempSync(join(tmpdir(), 'native-controls-')); roots.push(root);
 const listeners = new Set<{ queue: unknown[]; wake?: () => void }>();
 const emit = (e: unknown) => { for (const listener of listeners) { listener.queue.push(e); listener.wake?.(); } };
 const stream = { async *[Symbol.asyncIterator]() {
  const listener: { queue: unknown[]; wake?: () => void } = { queue: [] }; listeners.add(listener);
  try { yield { type: 'server.connected' }; for (;;) { if (listener.queue.length) yield listener.queue.shift(); else await new Promise<void>((r) => { listener.wake = r; }); } }
  finally { listeners.delete(listener); }
 } };
 const discovery = { global: { health: async () => ({ data: { version: '1.17.9' } }) },
  app: { skills: async () => ({ data: [{ name: 'probe', description: 'Harmless', location: '/fixture/SKILL.md', content: 'nonce' }] }) },
  command: { list: async () => ({ data: [{ name: 'probe', source: 'skill', hints: [] }] }) },
  provider: { list: async () => ({ data: { all: [{ id: 'p', models: { m: { id: 'm', name: 'M' } } }], connected: ['p'], default: { p: 'm' } } }) } };
 let session = 's1';
 const command = vi.fn(async (request) => {
  const input = request.body.messageID;
  emit({ type: 'message.updated', properties: { info: { role: 'user', id: input, sessionID: session } } });
  const info = { role: 'assistant', id: `as_${input}`, parentID: input, sessionID: session, finish: 'stop', time: { created: Date.now(), completed: Date.now() } };
  emit({ type: 'message.updated', properties: { info } });
  return { data: { info, parts: [] } };
 });
 const client = { event: { subscribe: async () => ({ stream }) }, session: { create: vi.fn(async () => ({ data: { id: session } })),
  command, prompt: vi.fn(command), summarize: vi.fn(async () => ({ data: true })), messages: vi.fn(async () => ({ data: [] as unknown[] })), abort: vi.fn(async () => ({ data: true })) } };
 let nativeState: { version: number; value: unknown } | undefined;
 const execution: CapabilityExecution = { requestId: 'request', systemPrompt: 'persona + reply CLI', contextKey: 'ctx', promptOwner: 'u', authorizationEpoch: 'epoch',
  conversation: { id: 'c', generation: 1, get nativeState() { return nativeState; }, assertCurrent: vi.fn(),
   saveNativeState: vi.fn(async () => {}), registerNativeAlias: vi.fn(async () => {}), registerNative: vi.fn(async (_id, state) => { nativeState = state; }) },
  emit: vi.fn(async () => {}), submitted: vi.fn(async () => {}), selectModel: vi.fn(async () => {}), replaceSession: vi.fn(async () => 2), saveRecovery: vi.fn(async () => {}),
  bindTurn: vi.fn(async () => ({ token: 'a'.repeat(64), runId: 'native-unit', thinkingId: 'thinking' })), selectedModel: { providerID: 'p', modelID: 'm' } };
 const server = { url: 'http://127.0.0.1:4096', ensureStarted: vi.fn(async () => {}), getClient: () => client, getDiscoveryClient: () => discovery } as unknown as OpencodeServerManager;
 const driver = new OpencodeDriver({ server, runBindDir: root });
 return { root, driver, client, execution, emit, setSession: (s: string) => { session = s; } };
}
describe('OpenCode native controls', () => {
 it('does not regress newer readback text when delayed SSE prefixes arrive before START readiness', async () => {
  const f = fixture(), ctx = { workspace: f.root, signal: new AbortController().signal };
  const catalog = await f.driver.discoverCapabilities(ctx);
  let ready!: () => void, finish!: (v: any) => void;
  const gate = new Promise<void>((r) => { ready = r; });
  f.execution.bindTurn = vi.fn(async () => { await gate; return { token: 'a'.repeat(64), runId: 'run', thinkingId: 'thinking' }; });
  f.client.session.command.mockImplementation(() => new Promise((r) => { finish = r; }));
  const pending = f.driver.executeCapability({ ...ctx, capabilityId: 'skill:probe', catalogVersion: catalog.version, execution: f.execution });
  await vi.waitFor(() => expect(f.client.session.command).toHaveBeenCalledOnce());
  const inputId = f.client.session.command.mock.calls[0][0].body.messageID;
  const info = { role: 'assistant', id: 'assistant', sessionID: 's1', parentID: inputId };
  const part = (text: string) => ({ id: 'text-part', type: 'reasoning', text, messageID: 'assistant', sessionID: 's1' });
  const thought = () => vi.mocked(f.execution.emit).mock.calls.flatMap(([e]) => e.type === 'turn' && e.turn.event?.type === 'thinking' ? [e.turn.event.text] : []).join('');
  f.emit({ type: 'message.updated', properties: { info } });
  f.emit({ type: 'message.part.updated', properties: { part: part('abc') } });
  await vi.waitFor(() => expect(thought()).toBe('abc'));
  const final = { ...info, finish: 'stop', time: { completed: Date.now() } };
  f.client.session.messages.mockResolvedValue({ data: [{ info: final, parts: [part('abcdef')] }] });
  finish({ data: { info: final, parts: [part('abcdef')] } });
  await vi.waitFor(() => expect(thought()).toBe('abcdef'));
  f.emit({ type: 'message.part.updated', properties: { part: part('abcd'), delta: 'd' } });
  f.emit({ type: 'message.part.updated', properties: { part: part('abcdef'), delta: 'ef' } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  ready(); expect(await pending).toMatchObject({ status: 'completed' }); expect(thought()).toBe('abcdef');
 });
 it('attributes uniquely provable overlapping compactions without serializing native submission', async () => {
  const f = fixture(), ctx = { workspace: f.root, signal: new AbortController().signal };
  await f.execution.conversation.registerNative!('s1', { version: 1, value: { sessionID: 's1', directory: f.root } });
  const catalog = await f.driver.discoverCapabilities(ctx);
  const history = { info: { id: 'history', role: 'user', model: { providerID: 'p', modelID: 'm' } }, parts: [] };
  const control = (id: string) => ({ info: { id, role: 'user' }, parts: [{ type: 'compaction', auto: false }] });
  const summary = (id: string) => ({ info: { id: `summary-${id}`, role: 'assistant', parentID: id, summary: true, finish: 'stop' }, parts: [{ type: 'text', text: 'summary' }] });
  f.client.session.messages.mockResolvedValueOnce({ data: [history] }).mockResolvedValueOnce({ data: [history, control('a')] })
   .mockResolvedValueOnce({ data: [history, control('a'), summary('a')] }).mockResolvedValueOnce({ data: [history, control('a'), summary('a'), control('b'), summary('b')] });
  const resolves: Array<(v: { data: boolean }) => void> = [];
  f.client.session.summarize.mockImplementation(() => new Promise((r) => { resolves.push(r); }));
  const input = { ...ctx, capabilityId: 'session.compact', catalogVersion: catalog.version, execution: f.execution };
  let firstDone = false;
  const a = f.driver.executeCapability(input).then((v) => { firstDone = true; return v; });
  await vi.waitFor(() => expect(resolves).toHaveLength(1));
  const b = f.driver.executeCapability({ ...input, execution: { ...f.execution, requestId: 'b' } });
  await vi.waitFor(() => expect(resolves).toHaveLength(2));
  resolves[0]({ data: true });
  await vi.waitFor(() => expect(f.client.session.messages).toHaveBeenCalledTimes(3));
  expect(firstDone).toBe(false); resolves[1]({ data: true });
  expect(await a).toMatchObject({ status: 'completed', effect: { controlId: 'a', summaryId: 'summary-a' } });
  expect(await b).toMatchObject({ status: 'completed', effect: { controlId: 'b', summaryId: 'summary-b' } });
 });
 it('does not freeze an intermediate assistant ID into unknown receipts before read-only final recovery', async () => {
  const f = fixture(), ctx = { workspace: f.root, signal: new AbortController().signal };
  const catalog = await f.driver.discoverCapabilities(ctx);
  let reject!: (e: Error) => void;
  f.client.session.command.mockImplementation(() => new Promise((_, r) => { reject = r; }));
  const pending = f.driver.executeCapability({ ...ctx, capabilityId: 'skill:probe', catalogVersion: catalog.version, execution: f.execution });
  await vi.waitFor(() => expect(f.client.session.command).toHaveBeenCalledOnce());
  const inputId = f.client.session.command.mock.calls[0][0].body.messageID;
  f.emit({ type: 'message.updated', properties: { info: { sessionID: 's1', id: 'intermediate', role: 'assistant', parentID: inputId, finish: 'tool-calls', time: { completed: Date.now() } } } });
  await vi.waitFor(() => expect(f.execution.bindTurn).toHaveBeenCalledOnce());
  reject(new Error('transport disconnected'));
  const receipt = await pending;
  expect(receipt).toMatchObject({ status: 'unknown', nativeRef: { sessionId: 's1', inputId } });
  expect(receipt.nativeRef?.messageId).toBeUndefined();
  f.client.session.messages.mockResolvedValue({ data: [{ info: { sessionID: 's1', id: 'final', role: 'assistant', parentID: inputId, finish: 'stop' }, parts: [] }] });
  expect(await f.driver.executeCapability({ ...ctx, capabilityId: 'skill:probe', catalogVersion: catalog.version, recovery: { generation: 1, receipt, nativeRef: receipt.nativeRef } }))
   .toMatchObject({ status: 'completed', reconciled: true, nativeRef: { messageId: 'final' } });
  expect(f.client.session.command).toHaveBeenCalledOnce();
 });
 it('reconciles a persisted unknown from exact native parents using reads only, never replays missing or conflicting evidence', async () => {
  const f = fixture();
  const receipt = { status: 'unknown' as const, generation: '1', nativeRef: { sessionId: 's1', inputId: 'persisted' } };
  const input = { workspace: f.root, signal: new AbortController().signal, capabilityId: 'skill:probe', catalogVersion: 'old-catalog',
   recovery: { receipt, generation: 1, nativeRef: receipt.nativeRef } };
  f.client.session.messages.mockResolvedValue({ data: [{ info: { sessionID: 's1', id: 'final', role: 'assistant', parentID: 'persisted', finish: 'stop' }, parts: [] }] });
  expect(await f.driver.executeCapability(input)).toMatchObject({ status: 'completed', reconciled: true, generation: '1', nativeRef: { inputId: 'persisted', messageId: 'final' } });
  expect(await f.driver.executeCapability({ ...input, recovery: { ...input.recovery, nativeRef: undefined } })).toEqual(receipt);
  f.client.session.messages.mockResolvedValue({ data: [{ info: { sessionID: 's1', id: 'foreign', role: 'assistant', parentID: 'other', finish: 'stop' }, parts: [] }] });
  expect(await f.driver.executeCapability(input)).toEqual(receipt);
  expect(f.client.session.command).not.toHaveBeenCalled(); expect(f.client.session.create).not.toHaveBeenCalled();
  expect(f.client.session.prompt).not.toHaveBeenCalled(); expect(f.client.session.summarize).not.toHaveBeenCalled(); expect(f.client.session.abort).not.toHaveBeenCalled();
 });
 it('submits during true in-flight prompt and attributes identical HTTP assistants using their actual parents', async () => {
  const f = fixture(), ctx = { workspace: f.root, signal: new AbortController().signal };
  const catalog = await f.driver.discoverCapabilities(ctx);
  let finishPrompt!: (value: any) => void, finishCommand!: (value: any) => void;
  f.client.session.prompt.mockImplementation(() => new Promise((r) => { finishPrompt = r; }));
  f.client.session.command.mockImplementation(() => new Promise((r) => { finishCommand = r; }));
  const ordinary: PreparedRun = { runId: 'ordinary', message: 'first', ...ctx, conversation: f.execution.conversation,
   systemPrompt: 'ordinary persona', replyToken: 'b'.repeat(64), replyThinkingId: 'thinking-old', saveRecovery: f.execution.saveRecovery, capabilities: { invoke: async () => {} } };
  const result: AgentEvent[] = [];
  const first = (async () => { for await (const event of f.driver.createRun(ordinary).events) result.push(event); })();
  await vi.waitFor(() => expect(f.client.session.prompt).toHaveBeenCalledOnce());
  const a = f.client.session.prompt.mock.calls[0][0].body.messageID;
  const second = f.driver.executeCapability({ ...ctx, catalogVersion: catalog.version, capabilityId: 'skill:probe', execution: f.execution });
  await vi.waitFor(() => expect(f.client.session.command).toHaveBeenCalledOnce());
  const b = f.client.session.command.mock.calls[0][0].body.messageID;
  expect(a).not.toBe(b);
  const firstInfo = { role: 'assistant', sessionID: 's1', id: 'assistant-first', parentID: a, finish: 'stop', time: { completed: Date.now() } };
  const lastInfo = { role: 'assistant', sessionID: 's1', id: 'assistant-last', parentID: b, finish: 'stop', time: { completed: Date.now() } };
  f.emit({ type: 'message.updated', properties: { info: firstInfo } });
  f.emit({ type: 'message.updated', properties: { info: lastInfo } });
  // Native loop waiters both return the same final assistant, not one HTTP=one turn.
  finishPrompt({ data: { info: lastInfo, parts: [] } }); finishCommand({ data: { info: lastInfo, parts: [] } });
  f.client.session.messages.mockResolvedValue({ data: [{ info: firstInfo, parts: [] }, { info: lastInfo, parts: [] }] });
  await first;
  expect(result.at(-1)).toMatchObject({ type: 'done' });
  expect(await second).toMatchObject({ status: 'completed', nativeRef: { inputId: b, parentId: b, messageId: 'assistant-last' } });
  expect((await readInput(f.root, 's1', a))?.ready?.token).toBe('b'.repeat(64));
  expect((await readInput(f.root, 's1', b))?.ready?.token).toBe('a'.repeat(64));
  expect(f.client.session.abort).not.toHaveBeenCalled();
 });
 it.each(['tool-calls', 'unknown'])('does not complete or remove readiness on %s before the final same-parent assistant', async (finishReason) => {
  const f = fixture(), ctx = { workspace: f.root, signal: new AbortController().signal };
  const catalog = await f.driver.discoverCapabilities(ctx);
  let finish!: (v: any) => void, settled = false;
  f.client.session.command.mockImplementation(() => new Promise((r) => { finish = r; }));
  const pending = f.driver.executeCapability({ ...ctx, capabilityId: 'skill:probe', catalogVersion: catalog.version, execution: f.execution }).then((v) => { settled = true; return v; });
  await vi.waitFor(() => expect(f.client.session.command).toHaveBeenCalledOnce());
  const inputId = f.client.session.command.mock.calls[0][0].body.messageID;
  f.emit({ type: 'message.updated', properties: { info: { id: 'tool-assistant', sessionID: 's1', role: 'assistant', parentID: inputId, finish: finishReason, time: { completed: Date.now() } } } });
  await vi.waitFor(async () => expect((await readInput(f.root, 's1', inputId))?.ready).toBeDefined());
  expect(settled).toBe(false);
   f.emit({ type: 'message.part.updated', properties: { part: { sessionID: 's1', messageID: 'tool-assistant', type: 'reasoning', text: 'native thought' } } });
   f.emit({ type: 'message.part.updated', properties: { part: { sessionID: 's1', messageID: 'tool-assistant', type: 'tool', callID: 'call', tool: 'bash', state: { status: 'completed' } } } });
  f.client.session.messages.mockResolvedValue({ data: [{ info: { id: 'tool-assistant', role: 'assistant', sessionID: 's1', parentID: inputId, finish: 'tool-calls' }, parts: [
    { sessionID: 's1', messageID: 'tool-assistant', type: 'tool', callID: 'call', tool: 'bash', state: { status: 'completed' } },
   ] }] });
   const info = { id: 'final-assistant', sessionID: 's1', role: 'assistant', parentID: inputId, finish: 'stop', time: { completed: Date.now() } };
  f.emit({ type: 'message.updated', properties: { info } }); finish({ data: { info, parts: [] } });
  expect(await pending).toMatchObject({ status: 'completed', nativeRef: { messageId: 'final-assistant' } });
  expect(f.execution.bindTurn).toHaveBeenCalledOnce();
   const turns = vi.mocked(f.execution.emit).mock.calls.map(([event]) => event).filter((event) => event.type === 'turn');
   expect(turns.slice(0, 2).map((event) => event.type === 'turn' ? event.turn.event?.type : '')).toEqual(expect.arrayContaining(['thinking', 'tool']));
   expect(turns.at(-1)).toMatchObject({ type: 'turn', turn: { phase: 'completed' } });
 });
 it('selects native model objects for later inputs without writing provider defaults', async () => {
  const f = fixture(), ctx = { workspace: f.root, signal: new AbortController().signal };
  const catalog = await f.driver.discoverCapabilities(ctx);
  expect(await f.driver.executeCapability({ ...ctx, capabilityId: 'model.set', catalogVersion: catalog.version, parameters: { providerId: 'p', modelId: 'm' }, execution: f.execution }))
   .toMatchObject({ status: 'completed', effect: { kind: 'model', providerId: 'p', modelId: 'm', effective: 'next_request' } });
  expect(f.execution.selectModel).toHaveBeenCalledWith({ providerID: 'p', modelID: 'm' });
  expect(f.client.session.create).not.toHaveBeenCalled();
 });
 it('creates an independent reset session without aborting or deleting old native work', async () => {
  const f = fixture(), ctx = { workspace: f.root, signal: new AbortController().signal };
  await f.execution.conversation.registerNative!('old', { version: 1, value: { sessionID: 'old', directory: f.root } });
  const catalog = await f.driver.discoverCapabilities(ctx);
  expect(await f.driver.executeCapability({ ...ctx, capabilityId: 'session.reset', catalogVersion: catalog.version, execution: f.execution }))
   .toMatchObject({ status: 'completed', generation: '1', nativeRef: { sessionId: 'old' }, effect: { kind: 'reset', sessionId: 's1', generation: '2' } });
  expect(f.client.session.abort).not.toHaveBeenCalled();
  expect(f.execution.replaceSession).toHaveBeenCalledOnce();
 });
 it('keeps an active old native input independent while reset selects a new generation and new reply finishes first', async () => {
  const f = fixture(), ctx = { workspace: f.root, signal: new AbortController().signal };
  await f.execution.conversation.registerNative!('old', { version: 1, value: { sessionID: 'old', directory: f.root } });
  const catalog = await f.driver.discoverCapabilities(ctx);
  const finish = new Map<string, (v: any) => void>();
  f.client.session.command.mockImplementation((request) => new Promise((resolve) => { finish.set(request.path.id, resolve); }));
  const oldPending = f.driver.executeCapability({ ...ctx, capabilityId: 'skill:probe', catalogVersion: catalog.version, execution: f.execution });
  await vi.waitFor(() => expect(f.client.session.command).toHaveBeenCalledOnce());
  const oldInput = f.client.session.command.mock.calls[0][0].body.messageID;
  f.emit({ type: 'message.updated', properties: { info: { sessionID: 'old', role: 'assistant', id: 'old-a', parentID: oldInput } } });
  await vi.waitFor(async () => expect((await readInput(f.root, 'old', oldInput))?.ready).toBeDefined());
  f.setSession('new');
  expect(await f.driver.executeCapability({ ...ctx, capabilityId: 'session.reset', catalogVersion: catalog.version, execution: { ...f.execution, requestId: 'reset' } }))
   .toMatchObject({ status: 'completed', effect: { sessionId: 'new', generation: '2' } });
  const next: CapabilityExecution = { ...f.execution, requestId: 'new-request', conversation: { ...f.execution.conversation, generation: 2, nativeState: { version: 1, value: { sessionID: 'new', directory: f.root } } },
   bindTurn: vi.fn(async () => ({ token: 'b'.repeat(64), runId: 'new-run', thinkingId: 'new-thinking' })), emit: vi.fn(async () => {}) };
  const newPending = f.driver.executeCapability({ ...ctx, capabilityId: 'skill:probe', catalogVersion: catalog.version, execution: next });
  await vi.waitFor(() => expect(f.client.session.command).toHaveBeenCalledTimes(2));
  const newInput = f.client.session.command.mock.calls[1][0].body.messageID;
  const newer = { sessionID: 'new', role: 'assistant', id: 'new-a', parentID: newInput, finish: 'stop', time: { completed: Date.now() } };
  f.emit({ type: 'message.updated', properties: { info: newer } }); finish.get('new')!({ data: { info: newer, parts: [] } });
  expect(await newPending).toMatchObject({ status: 'completed', generation: '2', nativeRef: { sessionId: 'new' } });
  const older = { sessionID: 'old', role: 'assistant', id: 'old-a', parentID: oldInput, finish: 'stop', time: { completed: Date.now() } };
  f.emit({ type: 'message.updated', properties: { info: older } }); finish.get('old')!({ data: { info: older, parts: [] } });
  expect(await oldPending).toMatchObject({ status: 'completed', generation: '1', nativeRef: { sessionId: 'old' } });
  f.emit({ type: 'session.error', properties: { sessionID: 'old', error: 'late old failure' } });
  expect(next.emit).toHaveBeenCalledTimes(1);
  expect(f.client.session.abort).not.toHaveBeenCalled();
 });
 it('requires manual part, exact summary parent and nonempty finished summary instead of HTTP true', async () => {
  const f = fixture(), ctx = { workspace: f.root, signal: new AbortController().signal };
  await f.execution.conversation.registerNative!('s1', { version: 1, value: { sessionID: 's1', directory: f.root } });
  const catalog = await f.driver.discoverCapabilities(ctx);
  const before = [{ info: { id: 'u', role: 'user', model: { providerID: 'p', modelID: 'm' } }, parts: [{ type: 'text', text: 'history' }] }];
  f.client.session.messages.mockResolvedValueOnce({ data: before }).mockResolvedValueOnce({ data: [...before,
   { info: { id: 'compact-u', role: 'user' }, parts: [{ id: 'part', type: 'compaction', auto: false }] },
   { info: { id: 'summary', role: 'assistant', parentID: 'compact-u', summary: true, finish: 'stop' }, parts: [{ type: 'text', text: 'Actual summary' }] },
  ] });
  expect(await f.driver.executeCapability({ ...ctx, capabilityId: 'session.compact', catalogVersion: catalog.version, execution: f.execution }))
   .toMatchObject({ status: 'completed', effect: { kind: 'compact', controlId: 'compact-u', summaryId: 'summary', summary: true } });
  f.client.session.messages.mockResolvedValue({ data: before });
  expect(await f.driver.executeCapability({ ...ctx, capabilityId: 'session.compact', catalogVersion: catalog.version, execution: f.execution }))
   .toMatchObject({ status: 'unknown', error: 'ambiguous_compaction' });
 });
 it('sends overlapping native compactions without a queue and refuses ambiguous shared summary attribution', async () => {
  const f = fixture(), ctx = { workspace: f.root, signal: new AbortController().signal };
  await f.execution.conversation.registerNative!('s1', { version: 1, value: { sessionID: 's1', directory: f.root } });
  const catalog = await f.driver.discoverCapabilities(ctx);
  const before = [{ info: { id: 'history', role: 'user', model: { providerID: 'p', modelID: 'm' } }, parts: [] }];
  f.client.session.messages.mockResolvedValue({ data: before });
  const resolves: Array<(v: { data: boolean }) => void> = [];
  f.client.session.summarize.mockImplementation(() => new Promise((r) => { resolves.push(r); }));
  const request = { ...ctx, capabilityId: 'session.compact', catalogVersion: catalog.version, execution: f.execution };
  const first = f.driver.executeCapability(request), second = f.driver.executeCapability({ ...request, execution: { ...f.execution, requestId: 'other' } });
  await vi.waitFor(() => expect(f.client.session.summarize).toHaveBeenCalledTimes(2));
  f.client.session.messages.mockResolvedValue({ data: [...before,
   { info: { id: 'control', role: 'user' }, parts: [{ type: 'compaction', auto: false }] },
   { info: { id: 'summary', role: 'assistant', parentID: 'control', summary: true, finish: 'stop' }, parts: [{ type: 'text', text: 'actual summary' }] },
  ] });
  resolves.forEach((r) => r({ data: true }));
  expect(await first).toMatchObject({ status: 'unknown', error: 'ambiguous_compaction' });
  expect(await second).toMatchObject({ status: 'unknown', error: 'ambiguous_compaction' });
  expect(f.client.session.abort).not.toHaveBeenCalled();
 });
 it('reports native summary error and a proven empty-session noop without invented summary success', async () => {
  const f = fixture(), ctx = { workspace: f.root, signal: new AbortController().signal };
  const catalog = await f.driver.discoverCapabilities(ctx);
  const request = { ...ctx, capabilityId: 'session.compact', catalogVersion: catalog.version, execution: f.execution };
  expect(await f.driver.executeCapability(request)).toMatchObject({ status: 'noop' });
  expect(f.client.session.summarize).not.toHaveBeenCalled();
  await f.execution.conversation.registerNative!('s1', { version: 1, value: { sessionID: 's1', directory: f.root } });
  f.client.session.messages.mockResolvedValueOnce({ data: [{ info: { id: 'u', role: 'user', model: { providerID: 'p', modelID: 'm' } }, parts: [] }] })
   .mockResolvedValueOnce({ data: [
    { info: { id: 'control', role: 'user' }, parts: [{ type: 'compaction', auto: false }] },
    { info: { id: 'summary', role: 'assistant', parentID: 'control', summary: true, finish: 'error', error: { name: 'APIError' } }, parts: [] },
   ] });
  expect(await f.driver.executeCapability(request)).toMatchObject({ status: 'failed', error: 'native_request_failed' });
 });
 it('executes a proven native skill command with an exact input/system/ready binding', async () => {
  const f = fixture(), context = { workspace: f.root, signal: new AbortController().signal };
  const catalog = await f.driver.discoverCapabilities(context);
  expect(catalog.capabilities.find((c) => c.id === 'skill:probe')).toMatchObject({ executable: true, source: 'skill' });
  const result = await f.driver.executeCapability({ ...context, catalogVersion: catalog.version, capabilityId: 'skill:probe', parameters: { arguments: ' x\ny ' }, execution: f.execution });
  expect(result).toMatchObject({ status: 'completed', nativeRef: { sessionId: 's1' } });
  expect(f.client.session.command).toHaveBeenCalledOnce();
  const request = f.client.session.command.mock.calls[0][0];
  expect(request.body).toMatchObject({ command: 'probe', arguments: ' x\ny ', model: 'p/m' });
  expect(request.body.system).toBeUndefined();
  const binding = await readInput(f.root, 's1', request.body.messageID);
  expect(binding).toMatchObject({ systemPrompt: 'persona + reply CLI', ready: { runId: 'native-unit' } });
  expect(f.client.session.prompt).not.toHaveBeenCalled();
  expect(f.client.session.abort).not.toHaveBeenCalled();
 });
});
