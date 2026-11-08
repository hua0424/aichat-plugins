import { randomBytes } from 'node:crypto';
import type { OpencodeClient } from '@opencode-ai/sdk';
import type { AgentEvent, AgentRun, CapabilityExecution, NativeRef, NativeTurnEvent, PreparedRun } from '../events.js';
import { publishInput, readyInput } from './input-bind.js';
import { defaultRunBindDir } from './run-bind.js';
import { mapOpencodeEvent } from './events.js';

let stamp = 0, counter = 0;
/** OpenCode 1.17.9 ascending message format; native history sorts by this time prefix. */
export function nativeInputId(): string {
 const now = Math.max(Date.now(), stamp); counter = now === stamp ? counter + 1 : 1; stamp = now;
 return `msg_${(BigInt(now) * 4096n + BigInt(counter)).toString(16).slice(-12).padStart(12, '0')}${randomBytes(7).toString('hex')}`;
}
interface Deps {
 client: OpencodeClient;
 session(): Promise<string>;
 model?: { providerID: string; modelID: string };
 runBindDir?: string;
 cancelTimeoutMs?: number;
 finished(): void;
}
/** One submitted input, NOT an exclusive native loop: native parent IDs own all terminal evidence. */
export class NativeInputRun implements AgentRun {
 readonly inputID = nativeInputId();
 nativeRef?: NativeRef;
 private sessionID?: string;
 private consuming = false;
 private submitted = false;
 private completed = false;
 private disposed = false;
 private cancelled = false;
 private readonly subscriptionAbort = new AbortController();
 private wake?: () => void;
 private iterator?: AsyncIterator<unknown>;
 constructor(private readonly input: PreparedRun, private readonly deps: Deps,
  private readonly command?: { name: string; execution: CapabilityExecution }) {}
 get events(): AsyncIterable<AgentEvent> {
  return { [Symbol.asyncIterator]: () => {
   if (this.consuming) throw new Error('OpenCode run events can be consumed only once');
   this.consuming = true; return this.execute();
  } };
 }
 private async *execute(): AsyncGenerator<AgentEvent> {
  const queue: AgentEvent[] = [], assistants = new Set<string>(), toolEvents = new Set<string>(), partTexts = new Map<string, string>();
  const start = Date.now(), input = this.input, execution = this.command?.execution;
  let ended = false, acknowledged = false, binding: Promise<void> | undefined, terminal = false;
  const push = (event: AgentEvent) => { if (!ended) { queue.push(event); this.wake?.(); } };
  const end = () => { ended = true; this.wake?.(); };
  const fail = (message: string) => { if (!terminal) { terminal = true; push({ type: 'error', message }); end(); } };
  const turn = (ref: NativeRef, phase: NativeTurnEvent['phase']): NativeTurnEvent => ({
   eventId: `${ref.sessionId}:${ref.messageId}:${phase}`, conversationId: input.conversation.id,
   generation: input.conversation.generation, nativeRef: ref, requestIds: execution ? [execution.requestId] : [], relation: 'new', phase,
  });
  const bind = (ref: NativeRef) => binding ??= (async () => {
   input.onNativeBound?.(ref);
   const ready = execution ? await execution.bindTurn(turn(ref, 'bound')) :
    input.replyToken && input.replyThinkingId ? { token: input.replyToken, runId: input.runId, thinkingId: input.replyThinkingId } : undefined;
   if (!ready) throw new Error('native START-ready binding unavailable');
   await readyInput(this.deps.runBindDir ?? defaultRunBindDir(), ref.sessionId, this.inputID, ready);
  })();
  const settle = (info: { id: string; parentID: string; sessionID: string; error?: unknown }) => {
   if (terminal) return;
   terminal = true;
   const ref: NativeRef = { sessionId: info.sessionID, inputId: this.inputID, messageId: info.id, parentId: info.parentID };
   this.nativeRef = ref;
   void (async () => {
    try {
     await bind(ref);
     await input.saveRecovery({ version: 1, value: { provider: 'opencode', sessionID: ref.sessionId, directory: input.workspace,
      inputID: this.inputID, nativeRef: ref, ancestorProof: 'verified', stopProbe: 'completed' } });
     this.completed = true;
     push(info.error ? { type: 'error', message: 'native_assistant_failed' } : { type: 'done', durationMs: Date.now() - start });
    } catch { push({ type: 'error', message: 'NATIVE_OUTCOME_UNKNOWN: native binding unconfirmed' }); }
    finally { end(); }
   })();
  };
  const observe = (raw: unknown) => {
   const e = raw as { type?: string; properties?: { info?: { role?: string; sessionID?: string; id?: string; parentID?: string; error?: unknown; finish?: string; time?: { completed?: number } }; part?: { id?: string; text?: string; callID?: string; messageID?: string }; tool?: { messageID?: string } } };
   const info = e?.properties?.info;
   if (e?.type === 'message.updated' && info && info.sessionID === this.sessionID) {
    if (info.role === 'user' && info.id === this.inputID && !acknowledged) {
     acknowledged = true;
     if (execution) void execution.emit({ type: 'receipt', receipt: { status: 'accepted', phase: 'accepted', generation: String(input.conversation.generation),
      nativeRef: { sessionId: this.sessionID!, inputId: this.inputID } } }).catch(() => {});
    }
    if (info.role === 'assistant' && info.parentID === this.inputID && info.id) {
     assistants.add(info.id);
     const ref = { sessionId: this.sessionID!, inputId: this.inputID, messageId: info.id, parentId: this.inputID };
     this.nativeRef = ref;
     void bind(ref).catch(() => fail('NATIVE_OUTCOME_UNKNOWN: native binding unconfirmed'));
     if (info.time?.completed && (info.error || (info.finish && !['tool-calls', 'unknown'].includes(info.finish)))) settle({ ...info, sessionID: this.sessionID!, id: info.id, parentID: this.inputID });
    }
   }
   const event = mapOpencodeEvent(raw, this.sessionID!, assistants);
   if (!event || event.type === 'done') return;
   if (event.type === 'error') {
    const owner = e.properties?.tool?.messageID;
    if (owner && assistants.has(owner)) fail(event.message);
    return; // session-wide idle/errors cannot identify this input.
   }
   if (event.type === 'thinking') {
     const part = e.properties?.part;
     if (part?.id && typeof part.text === 'string') {
      const previous = partTexts.get(part.id) ?? '';
      if (previous.startsWith(part.text)) return; // HTTP readback may have already observed a newer snapshot.
      partTexts.set(part.id, part.text);
      event.text = part.text.startsWith(previous) ? part.text.slice(previous.length) : event.text;
      if (!event.text) return;
     }
    }
    if (event.type === 'tool') {
    if (!e.properties?.part?.messageID || !assistants.has(e.properties.part.messageID)) return;
    const key = `${e.properties?.part?.callID}:${event.phase}`;
    if (toolEvents.has(key)) return; toolEvents.add(key);
   }
   push(event);
  };
  const onAbort = () => { void this.cancel('aborted'); };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
   if (input.signal.aborted || this.cancelled) { yield { type: 'cancelled', reason: 'Cancelled before submission' }; return; }
   input.signal.addEventListener('abort', onAbort, { once: true });
   this.sessionID = await this.deps.session();
   if (this.cancelled || input.signal.aborted) { yield { type: 'cancelled', reason: 'Cancelled before submission' }; return; }
   input.conversation.assertCurrent();
   const dir = this.deps.runBindDir ?? defaultRunBindDir();
   try { await publishInput(dir, { sessionID: this.sessionID, inputID: this.inputID, conversationId: input.conversation.id, generation: input.conversation.generation, systemPrompt: input.systemPrompt }); }
   catch { throw new Error('OpenCode run-bind publish failed'); }
   const recovery = { version: 1, value: { provider: 'opencode', runId: input.runId, sessionID: this.sessionID, inputID: this.inputID, directory: input.workspace, stopProbe: 'unconfirmed' } };
   await input.saveRecovery(recovery);
   const subscription = await this.deps.client.event.subscribe({ query: { directory: input.workspace }, signal: this.subscriptionAbort.signal, throwOnError: true });
   if (this.cancelled || input.signal.aborted) { yield { type: 'cancelled', reason: 'Cancelled before submission' }; return; }
   this.iterator = subscription.stream[Symbol.asyncIterator]();
   let connected!: () => void;
   const handshake = new Promise<void>((resolve) => { connected = resolve; });
   void (async () => {
    try {
     while (!this.disposed && !ended) {
      const next = await this.iterator!.next();
      if (next.done) { fail('NATIVE_OUTCOME_UNKNOWN: native SSE closed'); break; }
      if ((next.value as { type?: string })?.type === 'server.connected') connected();
      else observe(next.value);
     }
    } catch { if (!this.cancelled && !this.disposed) fail('NATIVE_OUTCOME_UNKNOWN: native SSE disconnected'); }
   })();
   let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
   try { await Promise.race([handshake, new Promise<never>((_, reject) => { handshakeTimer = setTimeout(() => reject(new Error('native SSE handshake unconfirmed')), 10_000); })]); }
   finally { if (handshakeTimer) clearTimeout(handshakeTimer); }
   if (ended) throw new Error('native SSE handshake unconfirmed');
   input.conversation.assertCurrent();
   if (this.cancelled || input.signal.aborted) { yield { type: 'cancelled', reason: 'Cancelled before submission' }; return; }
   const ref = { sessionId: this.sessionID, inputId: this.inputID };
   this.nativeRef = ref;
   if (execution) await execution.submitted(ref);
   this.submitted = true;
   const client = this.deps.client, model = input.getSelectedModel?.() ?? input.selectedModel ?? this.deps.model;
   const request = this.command ? client.session.command({ path: { id: this.sessionID }, query: { directory: input.workspace },
    body: { messageID: this.inputID, command: this.command.name, arguments: input.message, ...(model ? { model: `${model.providerID}/${model.modelID}` } : {}) }, throwOnError: true }) :
    client.session.prompt({ path: { id: this.sessionID }, query: { directory: input.workspace },
     body: { messageID: this.inputID, parts: [{ type: 'text', text: input.message }], system: input.systemPrompt, ...(model ? { model } : {}) }, throwOnError: true });
   void request.then(async (response) => {
    if (ended || terminal) return;
    const info = response.data?.info;
    if (info?.sessionID === this.sessionID && info.parentID === this.inputID) {
     if (info.finish && ['tool-calls', 'unknown'].includes(info.finish) && !info.error) { observe({ type: 'message.updated', properties: { info } }); return; }
     // Readback below drains persisted parts if HTTP overtook the SSE consumer.
    }
    // Both HTTP requests can return another input's final assistant. Query native history, never rebind it.
    const history = await client.session.messages({ path: { id: this.sessionID! }, query: { directory: input.workspace }, throwOnError: true });
    const own = (history.data ?? []).filter((row) => row.info.role === 'assistant' && row.info.parentID === this.inputID);
     if (info?.sessionID === this.sessionID && info.parentID === this.inputID && !own.some((row) => row.info.id === info.id)) own.push(response.data!);
     for (const row of own) {
      observe({ type: 'message.updated', properties: { info: { ...row.info, finish: undefined, time: undefined } } });
      for (const part of row.parts) observe({ type: 'message.part.updated', properties: { part } });
     }
     for (const row of own) observe({ type: 'message.updated', properties: { info: row.info } });
    // aichatoverview#505: a history snapshot without own completion is NOT terminal. The
    // command HTTP response can win the race while the own assistant is still running; its
    // completion (and later parts) may still arrive on SSE. Keep observing until completion,
    // stream loss, or the observation timeout below decides unknown.
   }).catch(() => { if (!terminal) fail('NATIVE_OUTCOME_UNKNOWN: native request outcome unavailable'); });
   timer = setTimeout(() => fail('NATIVE_OUTCOME_UNKNOWN: native observation timeout'), 5 * 60_000); timer.unref?.();
   while (!ended || queue.length) {
    if (this.cancelled) { yield { type: 'cancelled', reason: 'OpenCode stop not confirmed' }; return; }
    if (queue.length) yield queue.shift()!;
    else await new Promise<void>((resolve) => { this.wake = resolve; });
   }
  } catch (e) { yield { type: 'error', message: e instanceof Error ? e.message : 'native input failed' }; }
  finally {
   if (timer) clearTimeout(timer);
   input.signal.removeEventListener('abort', onAbort);
   this.subscriptionAbort.abort(); this.disposed = true;
   void this.iterator?.return?.().catch(() => {});
   this.deps.finished();
  }
 }
 async cancel(reason: string): Promise<Awaited<ReturnType<AgentRun['cancel']>>> {
  if (this.completed || !this.submitted) { this.cancelled = true; this.wake?.(); return { status: 'stopped' }; }
  this.cancelled = true; this.subscriptionAbort.abort(); this.wake?.();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
   const result = await Promise.race([this.deps.client.session.abort({ path: { id: this.sessionID! }, query: { directory: this.input.workspace }, throwOnError: true }),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, this.deps.cancelTimeoutMs ?? 10_000); })]);
   return { status: 'unconfirmed', reason: `${reason}: ${result?.data === true ? 'native stop not verified' : 'native abort not acknowledged'}` };
  } catch { return { status: 'unconfirmed', reason: 'native stop unconfirmed' }; }
  finally { if (timer) clearTimeout(timer); }
 }
 async dispose(): Promise<void> {
  if (this.disposed) return;
  this.disposed = true; this.subscriptionAbort.abort(); this.wake?.();
  // Observation cleanup is not a native stop. Controls MUST NOT force-abort on unknown.
  void this.iterator?.return?.().catch(() => {});
 }
}
