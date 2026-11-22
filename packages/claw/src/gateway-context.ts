import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { OpenClawPluginApi, PluginJsonValue } from './types.js';
import { readOpenclawRunBind, resolveOpenclawRunBindDir, validOpenclawRunId, waitForOpenclawRunBind } from './run-bind.js';

const NAMESPACE = 'aichat.gateway-context.v1';
const METHOD = 'aichat.gatewayContext';
const text = (v: unknown): v is string => typeof v === 'string' && !!v && v.length <= 4096 && !/[\x00-\x1f\x7f]/.test(v);
const object = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
type Owner = { nativeRunId: string; runId: string; conversationId: string; generation: number; createdAt: number };
type Observation = { schema: 1; stamp: string; state: 'pending' | 'ready' | 'deny'; nativeRunId: string; agentId: string; sessionKey: string; sessionId: string; workspaceDir: string; owner?: Owner };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Native metadata only: no prompt/event inspection, tool mutation or metadata filesystem writes. */
export function registerGatewayContext(api: OpenClawPluginApi): void {
 const sdk = api.runContext, registerMethod = api.registerGatewayMethod, events = api.agent?.events;
 if (!sdk || !registerMethod || !events) return;
 const stamp = randomUUID();
 let healthy = true;
 const get = (runId: string) => sdk.getRunContext({ runId, namespace: NAMESPACE });
 const set = (runId: string, value: PluginJsonValue) => {
  try { if (!sdk.setRunContext({ runId, namespace: NAMESPACE, value })) healthy = false; }
  catch { healthy = false; }
  return healthy;
 };
 const denial = (runId: string, previous?: Record<string, unknown>): PluginJsonValue => ({
  schema: 1, stamp: text(previous?.stamp) ? previous.stamp : stamp, state: 'deny', nativeRunId: runId,
 });
 const deny = (runId: string, previous: Record<string, unknown>) => set(runId, denial(runId, previous));
 api.on('before_prompt_build', async (_event, ctx) => {
  const runId = ctx?.runId;
  if (!healthy || !validOpenclawRunId(runId)) return;
  try {
   const prior = get(runId), previous = object(prior);
   // Reload may not refresh an older observation or revive a denial.
   if (prior !== undefined && (!previous || previous.schema !== 1 || previous.stamp !== stamp || previous.state === 'deny')) return;
   if (!ctx || !['agentId', 'sessionKey', 'sessionId', 'workspaceDir'].every(key => text(ctx[key])) || !isAbsolute(ctx.workspaceDir as string)) {
    if (previous) deny(runId, previous);
    return;
   }
   const observed = { nativeRunId: runId, agentId: ctx.agentId as string, sessionKey: ctx.sessionKey as string,
    sessionId: ctx.sessionId as string, workspaceDir: ctx.workspaceDir as string };
   if (previous && Object.entries(observed).some(([key, value]) => previous[key] !== value)) { deny(runId, previous); return; }
   const pending: Observation = { schema: 1, stamp, state: 'pending', ...observed };
   if (!previous && !set(runId, pending)) return;
   const captured = previous ?? pending;
   const dir = resolveOpenclawRunBindDir();
   const binding = await waitForOpenclawRunBind(dir, runId);
   if (!healthy || !same(get(runId), captured) || !binding || binding.observerStamp !== stamp) return;
   const owner: Owner = { nativeRunId: runId, runId: binding.runId, conversationId: binding.conversationId,
    generation: binding.generation, createdAt: binding.createdAt };
   if (previous?.owner && !same(previous.owner, owner)) { deny(runId, previous); return; }
   const current = await readOpenclawRunBind(dir, runId);
   if (!healthy || !same(get(runId), captured) || !same(current, binding)) return;
   set(runId, { ...pending, state: 'ready', owner });
  } catch { healthy = false; }
 });
 events.registerAgentEventSubscription({ id: 'aichat.gateway-context-terminal', streams: ['lifecycle'], handle: (event, ctx) => {
  const { runId } = event, phase = String(event.data.phase);
  if (!validOpenclawRunId(runId) || !['end', 'error', 'aborted'].includes(phase)) return;
  // Deny synchronously: ordinary SDK writes can reject on a repeated closed-run event.
  try {
   const previous = get(runId), denied = denial(runId, object(previous));
   if (ctx && phase !== 'aborted') ctx.setRunContext(NAMESPACE, denied);
   else sdk.setRunContext({ runId, namespace: NAMESPACE, value: denied });
   const current = get(runId);
   if ((previous !== undefined || current !== undefined) && !same(current, denied)) healthy = false;
  } catch { healthy = false; }
 } });
 registerMethod(METHOD, ({ params, respond }) => {
  try {
   if (params.kind === 'observer') { respond(true, { schema: 1, stamp, healthy }); return; }
   if (!healthy || params.kind !== 'context' || params.stamp !== stamp || !validOpenclawRunId(params.nativeRunId)) {
    respond(true, { available: false }); return;
   }
   const value = object(get(params.nativeRunId));
   if (!value || value.schema !== 1 || value.stamp !== stamp || value.state !== 'ready' || value.nativeRunId !== params.nativeRunId ||
    !same(value.owner, params.owner) || !['agentId', 'sessionKey', 'sessionId', 'workspaceDir'].every(key => text(value[key]))) {
    respond(true, { available: false }); return;
   }
   respond(true, { available: true, observation: value });
  } catch { healthy = false; respond(true, { available: false }); }
 }, { scope: 'operator.read' });
}
