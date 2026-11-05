import { mkdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { AgentEvent, AgentRun, PreparedRun, RunDriver, AgentCapability, AgentCapabilityCatalog, AgentCapabilityContext, AgentCapabilityInvocation, AgentCapabilityResult, BoundConversation } from '../events.js';
import type { OpencodeServerManager } from './server-manager.js';
import { capabilityParameters } from '../capability-parameters.js';
import { NativeInputRun } from './native-input.js';
import { CompactionAttribution } from './compaction-attribution.js';

type Model = { providerID: string; modelID: string };
function parseModel(value?: string): Model | undefined {
 if (!value) return undefined;
 const slash = value.indexOf('/');
 return slash > 0 && slash < value.length - 1 ? { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) } : undefined;
}
const directoryOwners = new WeakMap<OpencodeServerManager, Map<string, string>>();
export interface OpencodeDriverDeps {
 server: OpencodeServerManager; model?: string;
 assertDirectoryOwner?: (conversationId: string, directory: string) => void;
 cancelTimeoutMs?: number; runBindDir?: string;
}
export class OpencodeDriver implements RunDriver {
 readonly type = 'opencode';
 readonly features = { cancel: 'best-effort', reset: 'supported', promptUpdate: 'per-run' } as const;
 private readonly active = new Set<NativeInputRun>();
 /** Only native session initialization is single-flight, never command/turn execution. */
 private readonly sessions = new Map<string, Promise<string>>();
 private readonly compactions = new CompactionAttribution();
 constructor(private readonly deps: OpencodeDriverDeps) {
  if (deps.cancelTimeoutMs !== undefined && (!Number.isFinite(deps.cancelTimeoutMs) || deps.cancelTimeoutMs < 0)) throw new RangeError('Invalid OpenCode cancel timeout');
 }
 async connect(): Promise<void> { await this.deps.server.ensureStarted(); }
 async discoverCapabilities(input: AgentCapabilityContext): Promise<AgentCapabilityCatalog> {
  const { catalog, providers } = await this.discoverSnapshot(input);
  if (input.capabilityId === 'model.set') {
   const params = capabilityParameters('discover', input.capabilityId, input.parameters);
   const query = params.query as string, offset = params.offset as number;
   const all = providers.all.flatMap((p) => Object.values(p.models).map((m) => ({ providerId: p.id, modelId: m.id, label: m.name, connected: providers.connected.includes(p.id) })))
    .sort((a, b) => a.providerId.localeCompare(b.providerId) || a.modelId.localeCompare(b.modelId))
    .filter((m) => `${m.providerId} ${m.modelId} ${m.label}`.toLowerCase().includes(query.toLowerCase()));
   catalog.models = { items: all.slice(offset, offset + 100), total: all.length, offset, ...(offset + 100 < all.length ? { nextOffset: offset + 100 } : {}) };
  }
  return catalog;
 }
 private async discoverSnapshot(input: AgentCapabilityContext) {
  if (!input.workspace) throw new Error('workspace_required');
  input.signal.throwIfAborted();
  await mkdir(input.workspace, { recursive: true });
  input.signal.throwIfAborted();
  await this.deps.server.ensureStarted();
  const client = this.deps.server.getDiscoveryClient(), options = { signal: input.signal, throwOnError: true } as const;
  const [health, skills, commands, providers] = await Promise.all([
   client.global.health(options), client.app.skills({ directory: input.workspace }, options),
   client.command.list({ directory: input.workspace }, options), client.provider.list({ directory: input.workspace }, options),
  ]);
  if (!health.data?.version || !Array.isArray(skills.data) || !Array.isArray(commands.data) || !Array.isArray(providers.data?.all) || !Array.isArray(providers.data.connected)) throw new Error('native_discovery_invalid');
  const metadata = (kind: 'skill' | 'command', name: string, description?: string, hints: string[] = []): AgentCapability => ({
   id: `${kind}:${name}`, kind, name,
   description: [description, hints.length ? 'Native argument hints only; requiredness unavailable; execution not connected.' : undefined].filter(Boolean).join(' '),
   supported: true, executable: false, reason: 'execution_not_connected', defaultVisibility: kind === 'skill' ? 'public' : 'hidden',
   scope: 'workspace', parameters: hints.map((hint) => ({ name: hint, type: 'string', required: false })),
  });
  const capabilities: AgentCapability[] = [
   { id: 'model.list', kind: 'model', name: 'Models', description: 'List native models available in this workspace.', supported: true, executable: true, defaultVisibility: 'public', scope: 'workspace', parameters: [] },
   { id: 'model.set', kind: 'model', name: 'Select model', source: 'model', supported: true, executable: true, defaultVisibility: 'public', scope: 'conversation', parameters: [{ name: 'providerId', type: 'string', required: true }, { name: 'modelId', type: 'string', required: true }] },
   ...['reset', 'compact'].map((name): AgentCapability => ({ id: `session.${name}`, kind: 'command', name, source: 'session', supported: true, executable: true, defaultVisibility: 'public', scope: 'conversation', parameters: [] })),
   ...skills.data.map((skill) => {
    const result = metadata('skill', skill.name, skill.description);
    if (skill.location && commands.data.some((c) => c.name === skill.name && c.source === 'skill')) {
     result.executable = true; delete result.reason; result.source = 'skill';
     result.parameters = [{ name: 'arguments', type: 'string', required: false }];
    }
    return result;
   }),
   ...commands.data.map((command) => ({ ...metadata('command', command.name, command.description, command.hints),
    ...(['skill', 'command', 'mcp'].includes(command.source ?? '') ? { source: command.source as 'skill' | 'command' | 'mcp' } : {}) })),
  ];
  capabilities.sort((a, b) => a.kind === b.kind ? a.id.localeCompare(b.id) : ['model', 'skill', 'command'].indexOf(a.kind) - ['model', 'skill', 'command'].indexOf(b.kind));
  const catalog: AgentCapabilityCatalog = { framework: this.type, runtimeVersion: health.data.version, capabilities,
   version: createHash('sha256').update(JSON.stringify([this.deps.server.url, input.workspace, health.data.version, capabilities, providers.data,
    commands.data.map(({ name, source, agent, model, subtask }) => ({ name, source, agent, model, subtask })), skills.data.map(({ name, location }) => ({ name, location }))])).digest('hex') };
  return { catalog, providers: providers.data };
 }
 async executeCapability(input: AgentCapabilityInvocation): Promise<AgentCapabilityResult> {
  if (input.recovery) return this.reconcile(input);
  let params: Record<string, string | number>;
  try { params = capabilityParameters('invoke', input.capabilityId, input.parameters); }
  catch { return { status: 'failed', error: 'invalid_parameters' }; }
  const { catalog, providers: data } = await this.discoverSnapshot(input);
  if (catalog.version !== input.catalogVersion) return { status: 'failed', error: 'catalog_stale' };
  if (!catalog.capabilities.find((c) => c.id === input.capabilityId)?.executable) return { status: 'unsupported', error: 'execution_not_connected' };
  if (input.capabilityId === 'model.list') {
   const models = data.all.flatMap((p) => Object.values(p.models).map((m) => ({ id: `${p.id}/${m.id}`, providerId: p.id, modelId: m.id, name: m.name, connected: data.connected.includes(p.id), default: data.default[p.id] === m.id })))
    .sort((a, b) => Number(b.connected) - Number(a.connected) || a.id.localeCompare(b.id));
   const lines = ['Available models:']; let length = lines[0].length;
   for (const model of models) {
    const line = `${model.id} — ${model.name} (${model.connected ? 'connected' : 'not connected'})`;
    if (length + line.length > 1800) { lines.push(`Showing ${lines.length - 1} of ${models.length} models (${models.filter((m) => m.connected).length} connected).`); break; }
    lines.push(line); length += line.length + 1;
   }
   return { status: 'completed', text: models.length ? lines.join('\n') : 'No models available.', nativeResult: { models } };
  }
  const execution = input.execution;
  if (!execution) return { status: 'unsupported', error: 'execution_not_connected' };
  const generation = String(execution.conversation.generation);
  execution.conversation.assertCurrent();
  if (input.capabilityId === 'model.set') {
   if (!data.all.some((p) => p.id === params.providerId && Object.values(p.models).some((m) => m.id === params.modelId))) return { status: 'failed', error: 'invalid_parameters' };
   await execution.submitted();
   await execution.selectModel({ providerID: params.providerId as string, modelID: params.modelId as string });
   return { status: 'completed', generation, text: 'Model selected for subsequent requests (native command/agent overrides still apply).',
    effect: { kind: 'model', providerId: params.providerId as string, modelId: params.modelId as string, effective: 'next_request' } };
  }
  if (input.capabilityId === 'session.reset') {
   const previous = execution.conversation.nativeState?.value as { sessionID?: string } | undefined;
   const nativeRef = previous?.sessionID ? { sessionId: previous.sessionID } : undefined;
   await execution.submitted(nativeRef);
   const created = await this.deps.server.getClient().session.create({ query: { directory: input.workspace }, body: { title: execution.conversation.id }, throwOnError: true });
   if (!created.data?.id || created.data.id === previous?.sessionID) return { status: 'unknown', generation, nativeRef, error: 'native_request_failed' };
   const state = { version: 1, value: { sessionID: created.data.id, directory: input.workspace } };
   // If CAS loses, retain exact orphan evidence; never create a second session or delete history.
   await execution.saveRecovery({ version: 1, value: { createdSessionID: created.data.id } });
   try {
    const next = await execution.replaceSession(created.data.id, state);
    return { status: 'completed', generation, nativeRef, text: 'New native session selected; previous work and history are retained.', effect: { kind: 'reset', sessionId: created.data.id, generation: String(next) } };
   } catch { return { status: 'failed', generation, nativeRef, error: 'native_request_failed', text: 'A native session was created but the conversation changed before binding. No automatic retry.' }; }
  }
  if (input.capabilityId === 'session.compact') return this.compact(input);
  if (input.capabilityId.startsWith('skill:')) {
   const prepared: PreparedRun = { runId: execution.requestId, message: params.arguments as string, workspace: input.workspace,
    systemPrompt: execution.systemPrompt, conversation: execution.conversation, signal: input.signal,
    saveRecovery: execution.saveRecovery, contextKey: execution.contextKey, promptOwner: execution.promptOwner,
    selectedModel: execution.selectedModel, getSelectedModel: execution.getSelectedModel, capabilities: { invoke: async () => { throw new Error('native CLI required'); } } };
   const run = this.inputRun(prepared, { name: input.capabilityId.slice(6), execution });
   let error: string | undefined, done = false, sequence = 0;
   for await (const event of run.events) {
    if (event.type === 'done') done = true;
    if (event.type === 'error') error = event.message;
    if ((event.type === 'thinking' || event.type === 'tool') && run.nativeRef?.messageId) {
     await execution.emit({ type: 'turn', turn: { eventId: `${execution.requestId}:event:${sequence++}`,
      conversationId: execution.conversation.id, generation: execution.conversation.generation,
      nativeRef: run.nativeRef, requestIds: [execution.requestId], relation: 'attached', phase: 'bound', event } });
    }
   }
   if ((done || error === 'native_assistant_failed') && run.nativeRef?.messageId) await execution.emit({ type: 'turn', turn: {
    eventId: `${execution.requestId}:terminal`, conversationId: execution.conversation.id, generation: execution.conversation.generation,
    nativeRef: run.nativeRef, requestIds: [execution.requestId], relation: 'attached', phase: done ? 'completed' : 'failed',
   } });
   const nativeRef = done || error === 'native_assistant_failed' ? run.nativeRef : run.nativeRef && { sessionId: run.nativeRef.sessionId, inputId: run.nativeRef.inputId };
   return { status: done ? 'completed' : error === 'native_assistant_failed' ? 'failed' : 'unknown', generation, nativeRef,
    ...(done ? { text: 'Native skill execution completed.' } : { error: 'native_request_failed' }) };
  }
  return { status: 'unsupported', error: 'execution_not_connected' };
 }
 private async reconcile(input: AgentCapabilityInvocation): Promise<AgentCapabilityResult> {
  const recovery = input.recovery!, ref = recovery.nativeRef, prior = recovery.receipt;
  if (!['accepted', 'unknown'].includes(prior.status) || !input.workspace || !ref?.sessionId || !ref.inputId ||
   (prior.generation !== undefined && prior.generation !== String(recovery.generation)) ||
   (prior.nativeRef && Object.entries(prior.nativeRef).some(([key, value]) => ref[key as keyof typeof ref] !== value))) return prior;
  if (!input.capabilityId.startsWith('skill:') && input.capabilityId !== 'session.compact') return prior;
  const abort = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
   const read = this.deps.server.getClient().session.messages({ path: { id: ref.sessionId }, query: { directory: input.workspace }, signal: abort.signal, throwOnError: true });
   const result = await Promise.race([read, new Promise<never>((_, reject) => { timeout = setTimeout(() => { abort.abort(); reject(new Error('recovery timeout')); }, 10_000); timeout.unref?.(); })]);
   const matches = (result.data ?? []).filter((row) => row.info.role === 'assistant' && row.info.sessionID === ref.sessionId && row.info.parentID === ref.inputId &&
    (!ref.messageId || row.info.id === ref.messageId) && (row.info.error || (row.info.finish && !['tool-calls', 'unknown'].includes(row.info.finish))));
   if (matches.length !== 1) return prior;
   const row = matches[0], info = row.info;
   if (info.role !== 'assistant') return prior;
   const nativeRef = { ...ref, messageId: info.id, parentId: info.parentID };
   if (info.error) return { status: 'failed', phase: 'outcome', generation: String(recovery.generation), nativeRef, reconciled: true, error: 'native_request_failed' };
   if (input.capabilityId === 'session.compact') {
    const manual = (result.data ?? []).some((m) => m.info.id === ref.inputId && m.parts.some((p) => p.type === 'compaction' && p.auto === false));
    if (!manual || !info.summary || !row.parts.some((p) => p.type === 'text' && p.text.trim())) return prior;
    return { status: 'completed', phase: 'outcome', generation: String(recovery.generation), nativeRef, reconciled: true,
     effect: { kind: 'compact', controlId: ref.inputId, summaryId: info.id, summary: true } };
   }
   return { status: 'completed', phase: 'outcome', generation: String(recovery.generation), nativeRef, reconciled: true };
  } catch { return prior; }
  finally { if (timeout) clearTimeout(timeout); abort.abort(); }
 }
 private async compact(input: AgentCapabilityInvocation): Promise<AgentCapabilityResult> {
  const e = input.execution!, generation = String(e.conversation.generation);
  const previous = e.conversation.nativeState?.value as { sessionID?: string; directory?: string } | undefined;
  if (!previous?.sessionID) return { status: 'noop', generation, text: 'There is no native session history to compact.' };
  if (previous.directory !== input.workspace) return { status: 'failed', generation, error: 'native_request_failed' };
  const sessionId = previous.sessionID, nativeRef = { sessionId }, client = this.deps.server.getClient();
  const finishObservation = this.compactions.begin(JSON.stringify([input.workspace, sessionId]));
   let observed = false;


  try {
   const before = await client.session.messages({ path: { id: sessionId }, query: { directory: input.workspace }, throwOnError: true });
   const beforeIDs = new Set((before.data ?? []).map((m) => m.info.id));
   const last = (before.data ?? []).filter((m) => m.info.role === 'user').at(-1)?.info;
   if (!last) { observed = true; void finishObservation(); return { status: 'noop', generation, nativeRef, text: 'Native history is empty.' }; }
   const model = e.getSelectedModel?.() ?? e.selectedModel ?? (last.role === 'user' ? last.model : undefined) ?? parseModel(this.deps.model);
   if (!model) return { status: 'failed', generation, nativeRef, error: 'native_request_failed' };
   await e.saveRecovery({ version: 1, value: { sessionId, beforeIDs: [...beforeIDs] } });
   e.conversation.assertCurrent(); await e.submitted(nativeRef);
   await client.session.summarize({ path: { id: sessionId }, query: { directory: input.workspace }, body: model, throwOnError: true });
   const after = await client.session.messages({ path: { id: sessionId }, query: { directory: input.workspace }, throwOnError: true });
   const controls = (after.data ?? []).filter((m) => !beforeIDs.has(m.info.id) && m.parts.some((p) => p.type === 'compaction' && p.auto === false));
   observed = true;
    const controlId = await finishObservation({ before: beforeIDs, after: new Set(controls.map((row) => row.info.id)), reliable: true });
    if (!controlId) return { status: 'unknown', generation, nativeRef, error: 'ambiguous_compaction' };
   const control = controls.find((row) => row.info.id === controlId)!;
   const summaries = (after.data ?? []).filter((m) => m.info.role === 'assistant' && m.info.parentID === control.info.id && m.info.summary);
   if (summaries.length !== 1) return { status: 'unknown', generation, nativeRef: { ...nativeRef, inputId: control.info.id }, error: 'ambiguous_compaction' };
   const summary = summaries[0], info = summary.info;
   if (info.role !== 'assistant') return { status: 'unknown', generation, nativeRef, error: 'native_request_failed' };
   const ref = { ...nativeRef, inputId: control.info.id, messageId: info.id, parentId: info.parentID };
   if (info.error) return { status: 'failed', generation, nativeRef: ref, error: 'native_request_failed' };
   const text = summary.parts.filter((p) => p.type === 'text').map((p) => p.type === 'text' ? p.text : '').join('\n').trim();
   if (!info.finish || ['tool-calls', 'unknown'].includes(info.finish) || !text) return { status: 'unknown', generation, nativeRef: ref, error: 'native_request_failed' };
   await e.saveRecovery({ version: 1, value: { sessionId, controlId: control.info.id, summaryId: info.id, summary: true, finish: info.finish, textHash: createHash('sha256').update(text).digest('hex') } });
   return { status: 'completed', generation, nativeRef: ref, text: 'Native manual compaction produced a summary; history is retained.', effect: { kind: 'compact', controlId: control.info.id, summaryId: info.id, summary: true } };
  } finally { if (!observed) void finishObservation({ before: new Set(), after: new Set(), reliable: false }); }
 }
 private async session(conversation: BoundConversation, workspace: string): Promise<string> {
  const previous = conversation.nativeState?.value as { sessionID?: string; directory?: string } | undefined;
  if (previous !== undefined && (!previous || typeof previous !== 'object' || typeof previous.sessionID !== 'string' || !previous.sessionID || previous.directory !== workspace)) throw new Error('OpenCode native session/directory mismatch; explicit reset required (history retained)');
  await mkdir(workspace, { recursive: true });
  const physical = await realpath(workspace), directory = process.platform === 'win32' ? physical.toLowerCase() : physical;
  this.deps.assertDirectoryOwner?.(conversation.id, directory); conversation.assertCurrent();
  let owners = directoryOwners.get(this.deps.server);
  if (!owners) { owners = new Map(); directoryOwners.set(this.deps.server, owners); }
  if (owners.has(directory) && owners.get(directory) !== conversation.id) throw new Error('PROMPT_SCOPE_CONFLICT');
  owners.set(directory, conversation.id);
  await this.deps.server.ensureStarted();
  if (previous?.sessionID) return previous.sessionID;
  const key = `${conversation.id}:${conversation.generation}`;
  let pending = this.sessions.get(key);
  if (!pending) {
   pending = (async () => {
    conversation.assertCurrent();
    const created = await this.deps.server.getClient().session.create({ query: { directory: workspace }, body: { title: conversation.id }, throwOnError: true });
    if (!created.data?.id) throw new Error('native session creation unconfirmed');
    conversation.assertCurrent();
    if (!conversation.registerNative) throw new Error('atomic native registration unavailable');
    await conversation.registerNative(created.data.id, { version: 1, value: { sessionID: created.data.id, directory: workspace } });
    return created.data.id;
   })();
   this.sessions.set(key, pending);
   void pending.catch(() => { this.sessions.delete(key); });
  }
  return pending;
 }
 private inputRun(input: PreparedRun, command?: ConstructorParameters<typeof NativeInputRun>[2]): NativeInputRun {
  const deps = this.deps;
  const run = new NativeInputRun(input, { get client() { return deps.server.getClient(); },
   session: () => this.session(input.conversation, input.workspace!), model: parseModel(deps.model), runBindDir: deps.runBindDir,
   cancelTimeoutMs: deps.cancelTimeoutMs, finished: () => this.active.delete(run) }, command);
  this.active.add(run); return run;
 }
 createRun(input: PreparedRun): AgentRun {
  if (!input.runId || !input.conversation || !input.signal || typeof input.message !== 'string' || !input.workspace || typeof input.systemPrompt !== 'string' || !input.replyToken) throw new TypeError('Invalid OpenCode prepared run');
  return this.inputRun(input);
 }
 async disconnect(): Promise<void> { await Promise.all([...this.active].map((run) => run.cancel('driver disconnect'))); }
}
