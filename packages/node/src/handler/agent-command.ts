import type { AgentDriver, AgentCapabilityResult, CapabilityExecution } from '../agent/events.js';
import { capabilityParameters, isMutation } from '../agent/capability-parameters.js';
import { deriveWorkspaceDir } from '../agent/workspace.js';
import type { AgentCommandRequest, AgentCommandResponse } from '../stream/protocol.js';

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\x00-\x1f\x7f]/.test(v);
export interface CommandPreparation {
 prepare(request: AgentCommandRequest, workspace?: string): Promise<{ execution: CapabilityExecution } | { receipt: AgentCapabilityResult }>;
}
/** Independent native command lane; never acquires the ordinary chat queue/slot. */
export class AgentCommandHandler {
 private readonly requests = new Map<string, { fingerprint: string; result: Promise<AgentCommandResponse>; done: boolean }>();
 constructor(private readonly driver: AgentDriver, private readonly selfUid: string, private readonly workspaceBase?: string,
  private readonly preparation?: CommandPreparation) {}
 async handle(raw: unknown): Promise<AgentCommandResponse | undefined> {
  if (!object(raw) || !id(raw.requestId) || !id(raw.roomId)) return undefined;
  const correlation = { requestId: raw.requestId, roomId: raw.roomId };
  const fail = (error: string): AgentCommandResponse => ({ ...correlation, status: 'failed', error });
  if (raw.aiclawUid !== this.selfUid) return fail('identity_mismatch');
  const ctx = raw.context;
  if ((raw.operation !== 'discover' && raw.operation !== 'invoke') || !object(ctx) ||
   (ctx.roomType !== 1 && ctx.roomType !== 2) ||
    (raw.reconcileOnly !== undefined && typeof raw.reconcileOnly !== 'boolean') ||
   ['counterpartUid', 'workspaceDir', 'account', 'authorizationEpoch'].some((key) => ctx[key] !== undefined && typeof ctx[key] !== 'string') ||
   (ctx.isOwner !== undefined && typeof ctx.isOwner !== 'boolean') ||
   (ctx.roomType === 2 && (typeof ctx.isOwner !== 'boolean' || !id(ctx.counterpartUid))) ||
   (raw.operation === 'invoke' && (!id(raw.capabilityId) || !id(raw.catalogVersion))) ||
   (raw.operation === 'discover' && raw.capabilityId !== undefined && raw.capabilityId !== 'model.set')) return fail('invalid_request');
  const request = { ...raw } as unknown as AgentCommandRequest;
  try { request.parameters = capabilityParameters(request.operation, request.capabilityId, raw.parameters); }
  catch { return fail('invalid_request'); }
  const fingerprint = JSON.stringify([request.roomId, request.operation, request.capabilityId, request.catalogVersion,
   request.parameters, ctx.roomType, ctx.counterpartUid, ctx.isOwner, ctx.workspaceDir, ctx.account, ctx.authorizationEpoch]);
  // An internal evidence query must bypass an in-flight invocation promise/cache.
   if (request.reconcileOnly) return this.execute(request);
   const prior = this.requests.get(request.requestId);
  if (prior) {
   if (prior.fingerprint !== fingerprint) return fail('request_id_conflict');
   // A completed watchdog promise may precede a persisted reconciliation. Re-read the same journal, never resubmit.
   return prior.done && isMutation(request.operation, request.capabilityId) ? this.execute(request) : prior.result;
  }
  if (this.requests.size >= 256) {
   const oldest = [...this.requests].find(([, entry]) => entry.done);
   if (oldest) this.requests.delete(oldest[0]);
   else if (!isMutation(request.operation, request.capabilityId)) return fail('command_busy');
  }
  const entry = { fingerprint, result: this.execute(request), done: false };
  this.requests.set(request.requestId, entry);
  void entry.result.finally(() => { entry.done = true; });
  return entry.result;
 }
 private async execute(request: AgentCommandRequest): Promise<AgentCommandResponse> {
  const correlation = { requestId: request.requestId, roomId: request.roomId };
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let execution: CapabilityExecution | undefined, timedOut = false, accepted = false;
  const mutation = isMutation(request.operation, request.capabilityId);
   if (request.reconcileOnly && (!mutation || !this.preparation)) return { ...correlation, status: 'unknown', error: 'native_request_failed' };
  try {
   const workspace = this.workspaceBase ? deriveWorkspaceDir(this.workspaceBase, this.selfUid, { ...request.context, roomId: request.roomId }) : undefined;
   const context = { workspace, signal: abort.signal };
   if (mutation) {
    if (!this.preparation) return { ...correlation, status: 'unsupported', error: 'execution_not_supported' };
    const prepared = await this.preparation.prepare(request, workspace);
    if ('receipt' in prepared) return { ...prepared.receipt, ...correlation };
     if (request.reconcileOnly) return { ...correlation, status: 'unknown', error: 'native_request_failed' };
    execution = { ...prepared.execution, emit: async (event) => {
     if (event.type === 'receipt' && event.receipt.status === 'accepted') {
      accepted = true;
      if (timer) clearTimeout(timer);
      if (timedOut) return; // unknown cannot be erased by a late ACK.
     }
     await prepared.execution.emit(event);
    } };
   }
   const execute = async (): Promise<AgentCommandResponse> => {
    if (request.operation === 'discover') {
     if (!this.driver.discoverCapabilities) return { ...correlation, status: 'unsupported', error: 'discovery_not_supported' };
     return { ...correlation, status: 'completed', catalog: await this.driver.discoverCapabilities({ ...context,
      ...(request.capabilityId ? { capabilityId: request.capabilityId, parameters: request.parameters } : {}) }) };
    }
    if (!this.driver.executeCapability) return { ...correlation, status: 'unsupported', error: 'execution_not_supported' };
    let result: AgentCapabilityResult;
    try { result = await this.driver.executeCapability({ ...context, capabilityId: request.capabilityId!, parameters: request.parameters, catalogVersion: request.catalogVersion!, ...(execution ? { execution } : {}) }); }
    catch { result = { status: mutation ? 'unknown' : 'failed', error: 'native_request_failed' }; }
    if (execution) {
     result = { ...result, phase: 'outcome', ...(timedOut && ['completed', 'failed', 'noop'].includes(result.status) ? { reconciled: true } : {}) };
     await execution.emit({ type: 'receipt', receipt: result });
    }
    return { ...result, ...correlation };
   };
   return await Promise.race([execute(), new Promise<AgentCommandResponse>((resolve) => {
    if (accepted) return;
    timer = setTimeout(() => {
     timedOut = true;
     if (!mutation) abort.abort(); // Disconnecting a control transport must never abort native work.
     const result: AgentCommandResponse = { ...correlation, status: 'unknown', error: 'native_timeout', ...(mutation ? { phase: 'outcome' } : {}) };
     if (execution) void execution.emit({ type: 'receipt', receipt: result }).catch(() => {});
     resolve(result);
    }, 15_000);
   })]);
  } catch {
   return { ...correlation, status: 'failed', error: 'native_request_failed' };
  } finally { if (timer) clearTimeout(timer); }
 }
}
