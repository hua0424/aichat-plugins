import type { AgentCapabilityCatalog, AgentCapabilityContext, AgentCapabilityInvocation, AgentCapabilityResult, AgentDriver, AgentEvent, AgentRun, CapabilityExecution, NativeRef, PreparedRun } from '../events.js';
import { capabilityParameters } from '../capability-parameters.js';
import { CodexAppServer } from './app-server.js';
import { prepareCodexScope } from './codex-driver.js';
import { CodexGrantPublicationError, CodexTurnGrants, codexHookConfig } from './turn-grants.js';
import { codexCatalog } from './native-catalog.js';

type Scope = Awaited<ReturnType<typeof prepareCodexScope>>;
interface Session {
	channel: CodexAppServer; grants: CodexTurnGrants; threadId: string; scope: Scope; modelProvider?: string;
	references: number; retired: boolean; cacheKey?: string; cleanup?: Promise<void>;
}
type SessionInput = Pick<PreparedRun, 'conversation' | 'systemPrompt' | 'workspace' | 'saveRecovery' | 'runId' | 'selectedModel'>;
function frozenModel(input: Pick<PreparedRun, 'selectedModel' | 'getSelectedModel'>) {
	const model = input.getSelectedModel?.() ?? input.selectedModel;
	return model ? { ...model } : undefined;
}
function sessionState(session: Session, workspace: string) {
	return { version: 1, value: {
		...(session.scope.frozenPrompt !== undefined ? { originalPrompt: session.scope.systemPrompt, legacyConfirmationRequired: false } : {}),
		threadId: session.threadId, promptHash: session.scope.digest, workspace, nativeControls: true,
	} };
}

/** Clear sibling/previous run aliases before spawning a persistent native process. */
export function codexNativeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const denied = new Set(['AICHAT_CONTEXT_KEY', 'AICHAT_RUN_BIND', 'AICHAT_BIND', 'AICHAT_CC_RUN', 'OPENCODE_SESSION_ID',
		'CODEX_THREAD_ID', 'OPENCLAW_BIND', 'DSH_SESSION_ID', 'AICHAT_OPENCODE_RUNBIND_DIR', 'AICHAT_OPENCLAW_RUNBIND_DIR']);
	return { ...Object.fromEntries(Object.entries(env).filter(([name]) => !denied.has(name.toUpperCase()))), AICHAT_CODEX_NATIVE: '1' };
}

// Only the own hook config is converted. JSON strings are valid TOML basic strings too.
export function codexHookFlags(config: Record<string, unknown>): string[] {
	const inline = (value: unknown): string => Array.isArray(value) ? `[${value.map(inline).join(',')}]`
		: value && typeof value === 'object' ? `{${Object.entries(value).map(([key, child]) => `${JSON.stringify(key)}=${inline(child)}`).join(',')}}`
		: JSON.stringify(value);
	return Object.entries(config).flatMap(([name, value]) => ['-c', `${name}=${inline(value)}`]);
}

/** POSIX native-host path. Windows hosts continue using the existing SDK adapter. */
export class CodexNativeDriver implements AgentDriver {
	readonly type = 'codex';
	readonly features = { cancel: 'best-effort', reset: 'supported', promptUpdate: 'new-session' } as const;
	private readonly sessions = new Map<string, Promise<Session>>();
	private discovery?: CodexAppServer;
	constructor(private readonly deps: { command: string; env: NodeJS.ProcessEnv; model?: string;
		createChannel?: (args: string[], env: NodeJS.ProcessEnv) => CodexAppServer;
		createGrants?: () => Promise<CodexTurnGrants> }) {}
	async connect(): Promise<void> {}
	private async snapshot(input: AgentCapabilityContext) {
		if (!input.workspace) throw new Error('workspace_required');
		input.signal.throwIfAborted();
		this.discovery ??= this.deps.createChannel?.([], codexNativeEnv(this.deps.env)) ??
			new CodexAppServer({ command: this.deps.command, env: codexNativeEnv(this.deps.env) });
		await this.discovery.start();
		return codexCatalog(this.discovery, input.workspace, input.signal);
	}
	async discoverCapabilities(input: AgentCapabilityContext): Promise<AgentCapabilityCatalog> {
		const params = capabilityParameters('discover', input.capabilityId, input.parameters);
		const { catalog, models } = await this.snapshot(input);
		if (input.capabilityId === 'model.set') {
			const query = String(params.query).toLowerCase(), offset = params.offset as number;
			const all = models.filter((m) => `${m.providerId} ${m.modelId} ${m.label}`.toLowerCase().includes(query));
			catalog.models = { items: all.slice(offset, offset + 100), total: all.length, offset,
				...(offset + 100 < all.length ? { nextOffset: offset + 100 } : {}) };
		}
		return catalog;
	}
	async executeCapability(input: AgentCapabilityInvocation): Promise<AgentCapabilityResult> {
		if (input.recovery) return input.recovery.receipt; // Read-only replay; unknown never starts another thread.
		let params: Record<string, string | number>;
		try { params = capabilityParameters('invoke', input.capabilityId, input.parameters); }
		catch { return { status: 'failed', error: 'invalid_parameters' }; }
		if (!input.capabilityId.startsWith('skill:') && !['session.reset', 'model.list', 'model.set'].includes(input.capabilityId)) return { status: 'unsupported', error: 'execution_not_connected' };
		const { catalog, models, skills } = await this.snapshot(input);
		if (catalog.version !== input.catalogVersion) return { status: 'failed', error: 'catalog_stale' };
		if (!catalog.capabilities.find((c) => c.id === input.capabilityId)?.executable) return { status: 'unsupported', error: 'native_provider_unverified' };
		if (input.capabilityId.startsWith('skill:')) {
			const skill = skills.find((s) => `skill:${s.name}` === input.capabilityId)!;
			return this.skill(input, [{ type: 'skill', name: skill.name, path: skill.path },
				...(params.arguments ? [{ type: 'text', text: params.arguments, text_elements: [] }] : [])]);
		}
		if (input.capabilityId === 'model.list') return { status: 'completed', text: `${models.length} native models available in the model picker.`, nativeResult: { models } };
		if (input.capabilityId === 'model.set') {
			const model = models.find((m) => m.providerId === params.providerId && m.modelId === params.modelId);
			if (!model) return { status: 'failed', error: 'invalid_parameters' };
			return this.setModel(input, model);
		}
		const execution = input.execution;
		if (!execution || !input.workspace) return { status: 'unsupported', error: 'execution_not_connected' };
		const generation = String(execution.conversation.generation);
		const previous = object(execution.conversation.nativeState?.value)?.threadId;
		const nativeRef = typeof previous === 'string' ? { sessionId: previous } : undefined;
		// Explicit reset uses the currently prepared persona, never silently resumes an unverified old thread.
		const fresh: SessionInput = { runId: execution.requestId, workspace: input.workspace, systemPrompt: execution.systemPrompt,
			conversation: { ...execution.conversation, nativeState: undefined }, saveRecovery: execution.saveRecovery, selectedModel: frozenModel(execution) };
		const scope = await prepareCodexScope(fresh);
		execution.conversation.assertCurrent(); input.signal.throwIfAborted();
		await execution.submitted(nativeRef);
		let created: Session | undefined;
		try {
			created = await this.open(fresh, scope);
			if (created.threadId === previous) throw new Error('CODEX_NATIVE_RESET_REUSED_THREAD');
			await execution.saveRecovery({ version: 1, value: { provider: 'codex', createdThreadId: created.threadId,
				workspace: input.workspace, previousThreadId: previous ?? null } });
			execution.conversation.assertCurrent();
			const next = await execution.replaceSession(created.threadId, sessionState(created, input.workspace), fresh.selectedModel ?? null);
			created.cacheKey = JSON.stringify([execution.conversation.id, next]);
			this.sessions.set(created.cacheKey, Promise.resolve(created));
			// CAS has selected the new thread; cleanup failure must never close that new generation.
			try { await this.retire(JSON.stringify([execution.conversation.id, execution.conversation.generation])); }
			catch { return { status: 'unknown', generation, nativeRef, error: 'CODEX_RETIRED_CLEANUP_UNCONFIRMED',
				text: 'New thread selected; previous native channel cleanup unconfirmed. Do not automatically retry reset.' }; }
			return { status: 'completed', generation, nativeRef, effect: { kind: 'reset', sessionId: created.threadId, generation: String(next) },
				text: 'New native Codex thread selected. Previous work and history are retained; no stop is claimed.' };
		} catch {
			let revokeFailed = false;
			if (created) { try { await this.closeSession(created); } catch { revokeFailed = true; } }
			return { status: 'unknown', generation, nativeRef, error: revokeFailed ? 'CODEX_GRANT_REVOKE_FAILED' : 'native_request_failed',
				text: 'Native reset outcome unconfirmed. Retain the recorded thread evidence; do not automatically retry.' };
		}
	}
	createNativeInput(input: { message: string; workspace: string; signal: AbortSignal; execution: CapabilityExecution }): AgentRun {
		const e = input.execution;
		const prepared = { runId: e.requestId, message: input.message, workspace: input.workspace, systemPrompt: e.systemPrompt,
			conversation: e.conversation, saveRecovery: e.saveRecovery, signal: input.signal };
		return new CodexNativeRun(prepared, () => this.session({ ...prepared, selectedModel: frozenModel(e) }),
			(session, settled) => this.release(session, settled), { execution: e, items: [{ type: 'text', text: input.message, text_elements: [] }], receiptOutcomes: true });
	}
	private async skill(input: AgentCapabilityInvocation, items: Record<string, unknown>[]): Promise<AgentCapabilityResult> {
		const execution = input.execution;
		if (!execution || !input.workspace) return { status: 'unsupported', error: 'execution_not_connected' };
		execution.conversation.assertCurrent(); input.signal.throwIfAborted();
		const prepared = { runId: execution.requestId, message: '', workspace: input.workspace, systemPrompt: execution.systemPrompt,
			conversation: execution.conversation, saveRecovery: execution.saveRecovery, signal: input.signal };
		const run = new CodexNativeRun(prepared, () => this.session({ ...prepared, selectedModel: frozenModel(execution) }),
			(session, settled) => this.release(session, settled), { execution, items });
		let result: AgentCapabilityResult = { status: 'unknown', error: 'native_skill_outcome_unconfirmed' };
		for await (const event of run.events) {
			const nativeRef = run.nativeRef;
			if (event.type === 'done') result = { status: 'completed', nativeRef };
			if (event.type === 'error') result = { status: event.message.startsWith('NATIVE_OUTCOME_UNKNOWN:') ? 'unknown' : 'failed', nativeRef, error: event.message };
			if (event.type === 'cancelled') result = { status: 'unknown', nativeRef, error: 'native_skill_stop_unconfirmed' };
		}
		return { ...result, generation: String(execution.conversation.generation) };
	}
	private async setModel(input: AgentCapabilityInvocation, model: { providerId: string; modelId: string }): Promise<AgentCapabilityResult> {
		const execution = input.execution;
		if (!execution || !input.workspace) return { status: 'unsupported', error: 'execution_not_connected' };
		execution.conversation.assertCurrent(); input.signal.throwIfAborted();
		const generation = String(execution.conversation.generation);
		const previous = object(execution.conversation.nativeState?.value)?.threadId;
		await execution.submitted(typeof previous === 'string' ? { sessionId: previous } : undefined);
		let session: Session | undefined;
		try {
			session = await this.session({ runId: `${execution.requestId}:session`, workspace: input.workspace,
				systemPrompt: execution.systemPrompt, conversation: execution.conversation, saveRecovery: execution.saveRecovery, selectedModel: frozenModel(execution) });
			if (session.modelProvider !== model.providerId) return { status: 'failed', generation, error: 'native_provider_mismatch' };
			const nativeRef = { sessionId: session.threadId };
			await execution.saveRecovery({ version: 1, value: { provider: 'codex', kind: 'model', nativeRef,
				requestId: execution.requestId, modelId: model.modelId, modelProvider: model.providerId } });
			execution.conversation.assertCurrent(); input.signal.throwIfAborted();
			await session.channel.request('thread/settings/update', { threadId: session.threadId, model: model.modelId }, execution.requestId);
			execution.conversation.assertCurrent(); input.signal.throwIfAborted();
			await execution.selectModel({ providerID: model.providerId, modelID: model.modelId });
			return { status: 'accepted', phase: 'outcome', generation, nativeRef,
				effect: { kind: 'model', providerId: model.providerId, modelId: model.modelId, effective: 'next_request' },
				text: 'Native model setting accepted for subsequent turns. Response effectiveness has not been observed.' };
		} catch {
			return { status: 'unknown', generation, ...(session ? { nativeRef: { sessionId: session.threadId } } : {}),
				error: 'native_model_outcome_unconfirmed', text: 'Native model outcome unconfirmed. Do not automatically retry.' };
		} finally {
			if (session) {
				try { await this.release(session, true); }
				catch { return { status: 'unknown', generation, nativeRef: { sessionId: session.threadId },
					error: 'CODEX_MODEL_CLEANUP_UNCONFIRMED', text: 'Native model request submitted; retired channel cleanup unconfirmed. Do not automatically retry.' }; }
			}
		}
	}
	async disconnect(): Promise<void> {
		this.discovery?.close();
		await Promise.all([...this.sessions.values()].map(async (pending) => {
			const session = await pending.catch(() => undefined);
			if (session) await this.closeSession(session);
		}));
	}
	private async closeSession(session: Session): Promise<void> {
		const cleanup = session.cleanup ??= (async () => {
			try { await session.grants.dispose(); } finally { session.channel.close(); }
			if (session.cacheKey) this.sessions.delete(session.cacheKey);
		})();
		try { await cleanup; } finally { session.cleanup = undefined; }
	}
	private async retire(key: string): Promise<void> {
		const session = await this.sessions.get(key)?.catch(() => undefined);
		if (!session) { this.sessions.delete(key); return; }
		session.retired = true;
		if (!session.references) await this.closeSession(session);
	}
	private async release(session: Session, settled: boolean): Promise<void> {
		// Unknown submitted work still owns its native lifetime; reset is not stop evidence.
		if (!settled) return;
		session.references--;
		if (session.retired && !session.references) await this.closeSession(session);
	}
	createRun(input: PreparedRun): AgentRun {
		if (!input.runId || !input.workspace || !input.replyToken || !input.conversation || !input.signal)
			throw new TypeError('Codex native run requires prepared core input');
		return new CodexNativeRun(input, () => this.session({ ...input, selectedModel: frozenModel(input) }), (session, settled) => this.release(session, settled));
	}
	private async session(input: SessionInput): Promise<Session> {
		const scope = await prepareCodexScope(input);
		input.conversation.assertCurrent();
		const key = JSON.stringify([input.conversation.id, input.conversation.generation]);
		const existing = this.sessions.get(key);
		if (existing) {
			const session = await existing;
			input.conversation.assertCurrent();
			if (session.retired || session.scope.digest !== scope.digest || session.threadId !== scope.threadId)
				throw new Error('CODEX_NATIVE_SCOPE_CHANGED: explicit reset required');
			session.references++;
			return session;
		}
		const pending = this.open(input, scope).then(async (session) => {
			try {
				if (!input.conversation.registerNative) throw new Error('Codex atomic native registration unavailable');
				await input.conversation.registerNative(session.threadId, sessionState(session, input.workspace!));
				session.cacheKey = key;
				return session;
			} catch (error) { await this.closeSession(session); throw error; }
		});
		// Keep failed admission too: an unknown native start/resume must not be blindly retried.
		this.sessions.set(key, pending);
		const session = await pending;
		input.conversation.assertCurrent();
		session.references++;
		return session;
	}
	private async open(input: SessionInput, scope: Scope): Promise<Session> {
		const grants = await (this.deps.createGrants?.() ?? CodexTurnGrants.create());
		const args = codexHookFlags(codexHookConfig(grants.command()));
		const env = codexNativeEnv(this.deps.env);
		const channel = this.deps.createChannel?.(args, env) ?? new CodexAppServer({ command: this.deps.command, args, env });
		try {
			await channel.start();
			input.conversation.assertCurrent();
			if (input.selectedModel) {
				const config = object(object(await channel.request('config/read', { cwd: input.workspace, includeLayers: false }))?.config);
				if (config?.model_provider !== input.selectedModel.providerID) throw new Error('CODEX_NATIVE_SELECTED_MODEL_PROVIDER_UNVERIFIED');
				if (scope.threadId) {
					const existing = object(object(await channel.request('thread/read', { threadId: scope.threadId, includeTurns: false }))?.thread);
					if (existing?.id !== scope.threadId || existing.modelProvider !== input.selectedModel.providerID || existing.cwd !== input.workspace)
						throw new Error('CODEX_NATIVE_SELECTED_MODEL_PROVIDER_UNVERIFIED');
				}
			}
			input.conversation.assertCurrent();
			await input.saveRecovery({ version: 1, value: { provider: 'codex', runId: input.runId, threadId: scope.threadId ?? null,
				workspace: input.workspace, stopProbe: 'unknown-after-restart' } });
			input.conversation.assertCurrent();
			const raw = await channel.request(scope.threadId ? 'thread/resume' : 'thread/start', {
				...(scope.threadId ? { threadId: scope.threadId } : {}), cwd: input.workspace,
				developerInstructions: scope.systemPrompt, approvalPolicy: 'never', sandbox: 'danger-full-access',
				...((input.selectedModel?.modelID ?? this.deps.model) ? { model: input.selectedModel?.modelID ?? this.deps.model } : {}),
			}, input.runId);
			const response = object(raw), thread = object(response?.thread);
			if (typeof thread?.id !== 'string' || !thread.id || thread.cliVersion !== '0.142.3' ||
				thread.cwd !== input.workspace || (scope.threadId && thread.id !== scope.threadId) ||
				(input.selectedModel && response?.modelProvider !== input.selectedModel.providerID))
				throw new Error('CODEX_NATIVE_THREAD_UNVERIFIED');
			return { channel, grants, threadId: thread.id, scope, references: 0, retired: false,
				modelProvider: typeof response?.modelProvider === 'string' ? response.modelProvider : undefined };
		} catch (error) { try { await grants.dispose(); } finally { channel.close(); } throw error; }
	}
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

class CodexNativeRun implements AgentRun {
	private consumed = false;
	private submitted = false;
	private cancelled = false;
	private terminal = false;
	private interruptRequested = false;
	private ownsGrant = false;
	private settlementUnconfirmed = false;
	private channelFailure?: string;
	private session?: Session;
	private ref?: NativeRef;
	private nativeInput?: { itemId: string; turnId: string };
	private wake?: () => void;
	private readonly inbox: Array<{ method: string; params: unknown }> = [];
	attached = false;
	get nativeRef(): NativeRef | undefined { return this.ref; }
	constructor(private readonly input: Pick<PreparedRun, 'runId' | 'message' | 'workspace' | 'systemPrompt' | 'conversation' | 'saveRecovery' | 'signal' | 'replyToken' | 'replyThinkingId' | 'onNativeBound' | 'assertReplySettlement'>,
		private readonly getSession: () => Promise<Session>, private readonly releaseSession: (session: Session, settled: boolean) => Promise<void>,
		private readonly command?: { execution: CapabilityExecution; items: Record<string, unknown>[]; receiptOutcomes?: boolean }) {}
	get events(): AsyncIterable<AgentEvent> {
		return { [Symbol.asyncIterator]: () => {
			if (this.consumed) throw new Error('Codex native run can be consumed only once');
			this.consumed = true;
			return this.observe();
		} };
	}
	private async *observe(): AsyncGenerator<AgentEvent> {
		for await (const event of this.execute()) {
			if (this.command) {
				const e = this.command.execution, nativeRef = this.ref;
				if (nativeRef && (this.terminal || (event.type !== 'error' && event.type !== 'cancelled'))) await e.emit({ type: 'turn', turn: {
					eventId: `${e.requestId}:${event.type}`, conversationId: e.conversation.id, generation: e.conversation.generation,
					nativeRef, requestIds: [e.requestId], relation: this.attached ? 'attached' : 'new',
					phase: event.type === 'done' ? 'completed' : event.type === 'error' ? 'failed' : event.type === 'cancelled' ? 'cancelled' : 'bound',
					...(!this.attached ? { event } : {}) } });
				if (this.command.receiptOutcomes && ['done', 'error', 'cancelled'].includes(event.type)) await e.emit({ type: 'receipt', receipt: {
					status: event.type === 'done' ? 'completed' : event.type === 'error' && !event.message.startsWith('NATIVE_OUTCOME_UNKNOWN:') ? 'failed' : 'unknown',
					generation: String(e.conversation.generation), nativeRef,
					...(event.type === 'error' ? { error: event.message } : {}) } });
			}
			yield event;
		}
	}
	private async *execute(): AsyncGenerator<AgentEvent> {
		const input = this.input, started = Date.now();
		const onAbort = () => { void this.cancel('aborted').catch(() => { this.channelFailure = 'CODEX_GRANT_REVOKE_FAILED'; this.wake?.(); }); };
		let unsubscribe: (() => void) | undefined, offClose: (() => void) | undefined;
		let admit!: () => void, rejectAdmission!: (reason: Error) => void;
		const ready = new Promise<void>((resolve, reject) => { admit = resolve; rejectAdmission = reject; });
		void ready.catch(() => {});
		let binding: ReturnType<CapabilityExecution['bindTurn']> | undefined;
		try {
			if (this.cancelled || input.signal.aborted) { yield { type: 'cancelled', reason: 'Cancelled before submission' }; return; }
			if (!this.command && !input.replyThinkingId) throw new Error('Codex native run requires the exact START-ready reply grant');
			input.signal.addEventListener('abort', onAbort, { once: true });
			const session = this.session = await this.getSession();
			if (this.cancelled || input.signal.aborted) { yield { type: 'cancelled', reason: 'Cancelled before submission' }; return; }
			unsubscribe = session.channel.onNotification((method, params) => {
				const frame = object(params);
				if (frame?.threadId !== session.threadId || this.channelFailure) return;
				const item = object(frame.item);
				if (this.submitted && ['item/started', 'item/completed'].includes(method) && item?.type === 'userMessage' && item.clientId === input.runId) {
					if (typeof item.id !== 'string' || !item.id || typeof frame.turnId !== 'string' || !frame.turnId ||
						(this.nativeInput && (this.nativeInput.itemId !== item.id || this.nativeInput.turnId !== frame.turnId)))
						this.channelFailure = 'NATIVE_OUTCOME_UNKNOWN: registered native input association ambiguous; no new grant';
					else if (!this.nativeInput) {
						this.nativeInput = { itemId: item.id, turnId: frame.turnId };
						// Register the known ordinary owner synchronously, before either RPC ACK or recovery IO.
						// This is not a grant: START, durable recovery and the original lease still gate grant below.
						if (!this.command) {
							try { input.onNativeBound?.({ sessionId: session.threadId, turnId: frame.turnId }); }
							catch { this.channelFailure = 'NATIVE_OUTCOME_UNKNOWN: original native owner could not be registered; no new grant'; }
						} else {
							this.ref = { sessionId: session.threadId, turnId: frame.turnId, inputId: item.id };
							binding = this.command.execution.bindTurn({ eventId: `${input.runId}:bound`, conversationId: input.conversation.id,
								generation: input.conversation.generation, nativeRef: this.ref, requestIds: [input.runId], relation: 'new', phase: 'bound' }, ready);
							void binding.catch(() => {});
						}
					}
				}
				// ponytail: bound per-run buffering; overflow is unknown, never a silently dropped terminal.
				if (this.inbox.length >= 4096) this.channelFailure = 'CODEX_RESULT_UNKNOWN: native event buffer exceeded';
				else this.inbox.push({ method, params });
				this.wake?.();
			});
			offClose = session.channel.onClose(() => { this.channelFailure = 'CODEX_RESULT_UNKNOWN: native channel lost; do not resubmit'; this.wake?.(); });
			input.conversation.assertCurrent();
			const submission = { method: 'turn/start', requestId: `${input.runId}:turn`, threadId: session.threadId };
			await input.saveRecovery({ version: 1, value: { provider: 'codex', runId: input.runId, threadId: session.threadId,
				workspace: input.workspace, submission, stopProbe: 'unknown-after-restart' } });
			input.conversation.assertCurrent();
			if (this.cancelled || input.signal.aborted) { yield { type: 'cancelled', reason: 'Cancelled before submission' }; return; }
			if (this.command) {
				await this.command.execution.submitted({ sessionId: session.threadId });
				input.conversation.assertCurrent(); input.signal.throwIfAborted();
			}
			this.submitted = true;
			const raw = await session.channel.request('turn/start', { threadId: session.threadId, clientUserMessageId: input.runId,
				input: this.command?.items ?? [{ type: 'text', text: input.message, text_elements: [] }] }, submission.requestId);
			const turn = object(object(raw)?.turn);
			if (typeof turn?.id !== 'string' || !turn.id) throw new Error('CODEX_NATIVE_TURN_UNVERIFIED');
			// 0.142.3 ACKs a submission ID, which may steer an existing turn. Only the user item proves its turn.
			const proofDeadline = setTimeout(() => {
				this.channelFailure = 'NATIVE_OUTCOME_UNKNOWN: registered native input notification missing; do not resubmit'; this.wake?.();
			}, 15_000);
			try {
				while (!this.nativeInput && !this.channelFailure && !this.cancelled)
					await new Promise<void>((resolve) => { this.wake = resolve; });
			} finally { clearTimeout(proofDeadline); this.wake = undefined; }
			if (this.channelFailure) throw new Error(this.channelFailure);
			if (this.cancelled) { yield { type: 'cancelled', reason: 'Codex native stop unconfirmed' }; return; }
			this.ref = { sessionId: session.threadId, turnId: this.nativeInput!.turnId,
				...(this.command ? { inputId: this.nativeInput!.itemId } : {}) };
			try {
				await input.saveRecovery({ version: 1, value: { provider: 'codex', runId: input.runId, nativeRef: this.ref,
					...(this.command ? { inputProof: this.nativeInput, origin: { submissionId: turn.id,
						startedTurnId: this.inbox.some(frame => frame.method === 'turn/started' && object(object(frame.params)?.turn)?.id === this.ref!.turnId) ? this.ref!.turnId : null } } : {}), workspace: input.workspace, submission, stopProbe: 'unknown-after-restart' } });
			} catch {
				this.settlementUnconfirmed = true;
				throw new Error('NATIVE_OUTCOME_UNKNOWN: native reply locator could not be committed; no new grant');
			}
			const assertSettlement = () => {
				if (!input.assertReplySettlement) { input.conversation.assertCurrent(); return; }
				try { input.assertReplySettlement(this.ref!); }
				catch { this.settlementUnconfirmed = true; throw new Error('NATIVE_OUTCOME_UNKNOWN: original native reply lease unconfirmed; no new grant'); }
			};
			let replyToken = input.replyToken;
			if (this.command) {
				const e = this.command.execution;
				admit();
				const lease = await binding;
				if (!lease?.relation) throw new Error('native Codex core lease relation unconfirmed');
				this.attached = lease.relation === 'attached'; replyToken = lease.token;
				await e.emit({ type: 'receipt', receipt: { status: 'accepted', phase: 'accepted', generation: String(input.conversation.generation), nativeRef: this.ref } });
				input.conversation.assertCurrent();
			} else assertSettlement();
			if (!this.cancelled && !this.attached) {
				try { await session.grants.grant(this.ref, replyToken!); this.ownsGrant = true; }
				catch (error) {
					if (error instanceof CodexGrantPublicationError) {
						this.ownsGrant = true;
						if (this.cancelled) await this.cancel('cancelled during publication rollback');
					}
					if (error instanceof Error && error.message === 'CODEX_TURN_GRANT_CONFLICT') {
						throw new Error('NATIVE_OUTCOME_UNKNOWN: existing turn requires its original core lease; no new grant');
					}
					throw error;
				}
			}
			// Cancellation may have arrived while grant IO was pending; now clean only our acquired grant.
			if (this.cancelled && this.ownsGrant) await this.cancel('cancelled during grant');
			const seen = new Set<string>();
			while (!this.terminal) {
				if (this.cancelled) { yield { type: 'cancelled', reason: 'Codex native stop unconfirmed' }; return; }
				if (this.channelFailure) throw new Error(this.channelFailure);
				if (!this.inbox.length) await new Promise<void>((resolve) => { this.wake = resolve; });
				this.wake = undefined;
				const frame = this.inbox.shift();
				if (!frame) continue;
				const params = object(frame.params);
				if (params?.threadId !== this.ref.sessionId) continue;
				if (frame.method === 'turn/completed') {
					const complete = object(params.turn);
					if (!complete || complete.id !== this.ref.turnId) continue;
					this.terminal = true;
					if (this.ownsGrant) await session.grants.revoke(this.ref);
					if (complete.status === 'completed') yield { type: 'done', durationMs: Date.now() - started };
					else if (complete.status === 'interrupted') yield { type: 'cancelled', reason: 'Native turn interrupted; background process stop unconfirmed' };
					else yield { type: 'error', message: 'CODEX_NATIVE_TURN_FAILED' };
					return;
				}
				if (params.turnId !== this.ref.turnId) continue;
				if (frame.method === 'item/agentMessage/delta' && typeof params.delta === 'string') yield { type: 'thinking', text: params.delta };
				const item = object(params.item);
				if ((frame.method === 'item/started' || frame.method === 'item/completed') && typeof item?.id === 'string' &&
					['commandExecution', 'mcpToolCall', 'collabAgentToolCall', 'dynamicToolCall', 'fileChange'].includes(String(item.type))) {
					const id = `${frame.method}:${item.id}`;
					if (seen.has(id)) continue;
					seen.add(id);
					yield { type: 'tool', name: String(item.tool ?? item.type), phase: frame.method === 'item/started' ? 'start' : 'end' };
				}
			}
		} catch (error) {
			let message = error instanceof Error ? error.message : 'CODEX_NATIVE_RUN_FAILED';
			if (this.submitted && !this.terminal) {
				this.settlementUnconfirmed = true;
				if (!message.startsWith('NATIVE_OUTCOME_UNKNOWN:')) message = `NATIVE_OUTCOME_UNKNOWN: ${message}`;
			}
			yield { type: 'error', message };
		} finally {
			rejectAdmission(new Error('native input admission unconfirmed'));
			unsubscribe?.(); offClose?.(); input.signal.removeEventListener('abort', onAbort);
			if (this.ownsGrant && this.ref && this.session) {
				try { await this.session.grants.revoke(this.ref); }
				catch { this.channelFailure = 'CODEX_GRANT_REVOKE_FAILED'; if (!this.cancelled) this.session.channel.close(); }
			}
			if (this.session) await this.releaseSession(this.session, this.terminal || !this.submitted);
		}
	}
	async cancel(reason: string): Promise<Awaited<ReturnType<AgentRun['cancel']>>> {
		this.cancelled = true;
		let revokeFailed = false;
		try {
			if (this.ownsGrant && this.ref && this.session) {
				try { await this.session.grants.revoke(this.ref); } catch { revokeFailed = true; }
				if (!this.terminal && !this.interruptRequested) {
					this.interruptRequested = true;
					await this.session.channel.request('turn/interrupt', { threadId: this.ref.sessionId, turnId: this.ref.turnId }).catch(() => {});
				}
			}
		} finally {
			if (revokeFailed) { this.channelFailure = 'CODEX_GRANT_REVOKE_FAILED'; this.session?.channel.close(); }
			this.wake?.();
		}
		return this.submitted ? { status: 'unconfirmed', reason: `${reason}: ${revokeFailed ? 'CODEX_GRANT_REVOKE_FAILED; ' : ''}native background process tree stop not verified` } : { status: 'stopped' };
	}
	async dispose(): Promise<void> { if (!this.terminal && !this.settlementUnconfirmed) await this.cancel('dispose'); }
}
