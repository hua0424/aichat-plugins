import type { AgentDriver } from '../agent/events.js';
import { deriveWorkspaceDir } from '../agent/workspace.js';
import type { AgentCommandRequest, AgentCommandResponse } from '../stream/protocol.js';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;

/** Read-only native command lane: no chat slots, prompts, bindings or thinking events. */
export class AgentCommandHandler {
	// Read-only operations may be retried after process restart. Bound cache preserves in-flight duplicates.
	private readonly requests = new Map<string, { fingerprint: string; result: Promise<AgentCommandResponse>; done: boolean }>();
	constructor(private readonly driver: AgentDriver, private readonly selfUid: string, private readonly workspaceBase?: string) {}

	async handle(raw: unknown): Promise<AgentCommandResponse | undefined> {
		if (!object(raw) || !id(raw.requestId) || !id(raw.roomId)) return undefined;
		const correlation = { requestId: raw.requestId, roomId: raw.roomId };
		const fail = (error: string): AgentCommandResponse => ({ ...correlation, status: 'failed', error });
		if (raw.aiclawUid !== this.selfUid) return fail('identity_mismatch');
		const ctx = raw.context;
		if ((raw.operation !== 'discover' && raw.operation !== 'invoke') || !object(ctx) ||
			(ctx.roomType !== 1 && ctx.roomType !== 2) ||
			['counterpartUid', 'workspaceDir', 'account'].some((key) => ctx[key] !== undefined && typeof ctx[key] !== 'string') ||
			(ctx.isOwner !== undefined && typeof ctx.isOwner !== 'boolean') ||
			(ctx.roomType === 2 && (typeof ctx.isOwner !== 'boolean' || !id(ctx.counterpartUid))) ||
			(raw.parameters !== undefined && (!object(raw.parameters) || Object.keys(raw.parameters).length > 0)) ||
			(raw.operation === 'invoke' && (!id(raw.capabilityId) || !id(raw.catalogVersion)))) return fail('invalid_request');
		const request = raw as unknown as AgentCommandRequest;
		const fingerprint = JSON.stringify([request.roomId, request.operation, request.capabilityId, request.catalogVersion,
			ctx.roomType, ctx.counterpartUid, ctx.isOwner, ctx.workspaceDir, ctx.account]);
		const prior = this.requests.get(request.requestId);
		if (prior) return prior.fingerprint === fingerprint ? prior.result : fail('request_id_conflict');
		if (this.requests.size >= 256) {
			const oldest = [...this.requests].find(([, entry]) => entry.done);
			if (!oldest) return fail('command_busy');
			this.requests.delete(oldest[0]);
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
		try {
			const workspace = this.workspaceBase ? deriveWorkspaceDir(this.workspaceBase, this.selfUid,
				{ ...request.context, roomId: request.roomId }) : undefined;
			const context = { workspace, signal: abort.signal };
			const execute = async (): Promise<AgentCommandResponse> => {
				if (request.operation === 'discover') {
					if (!this.driver.discoverCapabilities) return { ...correlation, status: 'unsupported', error: 'discovery_not_supported' };
					return { ...correlation, status: 'completed', catalog: await this.driver.discoverCapabilities(context) };
				}
				if (!this.driver.executeCapability) return { ...correlation, status: 'unsupported', error: 'execution_not_supported' };
				return { ...await this.driver.executeCapability({ ...context, capabilityId: request.capabilityId!,
					parameters: request.parameters, catalogVersion: request.catalogVersion! }), ...correlation };
			};
			return await Promise.race([execute(), new Promise<AgentCommandResponse>((resolve) => {
				timer = setTimeout(() => { abort.abort(); resolve({ ...correlation, status: 'unknown', error: 'native_timeout' }); }, 15_000);
			})]);
		} catch {
			// Native errors may contain provider secrets or host paths. Do not relay them into chat/history.
			return { ...correlation, status: 'failed', error: 'native_request_failed' };
		} finally { if (timer) clearTimeout(timer); }
	}
}
