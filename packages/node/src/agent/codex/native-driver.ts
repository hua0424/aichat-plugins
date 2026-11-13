import { createHash } from 'node:crypto';
import type { AgentCapabilityCatalog, AgentCapabilityContext, AgentCapabilityInvocation, AgentCapabilityResult, AgentDriver, AgentEvent, AgentRun, NativeRef, PreparedRun } from '../events.js';
import { capabilityParameters } from '../capability-parameters.js';
import { CodexAppServer } from './app-server.js';
import { prepareCodexScope } from './codex-driver.js';
import { CodexTurnGrants, codexHookConfig } from './turn-grants.js';

type Scope = Awaited<ReturnType<typeof prepareCodexScope>>;
interface Session { channel: CodexAppServer; grants: CodexTurnGrants; threadId: string; scope: Scope }
type SessionInput = Pick<PreparedRun, 'conversation' | 'systemPrompt' | 'workspace' | 'saveRecovery' | 'runId'>;
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
	async discoverCapabilities(input: AgentCapabilityContext): Promise<AgentCapabilityCatalog> {
		if (!input.workspace) throw new Error('workspace_required');
		input.signal.throwIfAborted();
		this.discovery ??= this.deps.createChannel?.([], codexNativeEnv(this.deps.env)) ??
			new CodexAppServer({ command: this.deps.command, env: codexNativeEnv(this.deps.env) });
		await this.discovery.start();
		input.signal.throwIfAborted();
		// This staged adapter advertises only the proven control, never a synthetic compact success.
		return { version: createHash('sha256').update(JSON.stringify(['codex-native-reset-v1', '0.142.3', input.workspace])).digest('hex'),
			framework: 'codex', runtimeVersion: '0.142.3', capabilities: [
				{ id: 'session.reset', kind: 'command', name: 'New Codex thread', supported: true, executable: true,
					defaultVisibility: 'public', scope: 'conversation', parameters: [], source: 'session' },
				{ id: 'session.compact', kind: 'command', name: 'Compact Codex context', supported: false, executable: false,
					reason: 'native_request_and_summary_attribution_unproven', defaultVisibility: 'public', scope: 'conversation', parameters: [], source: 'session' },
			] };
	}
	async executeCapability(input: AgentCapabilityInvocation): Promise<AgentCapabilityResult> {
		if (input.recovery) return input.recovery.receipt; // Read-only replay; unknown never starts another thread.
		try { capabilityParameters('invoke', input.capabilityId, input.parameters); }
		catch { return { status: 'failed', error: 'invalid_parameters' }; }
		if (input.capabilityId !== 'session.reset') return { status: 'unsupported', error: 'execution_not_connected' };
		const catalog = await this.discoverCapabilities(input);
		if (catalog.version !== input.catalogVersion) return { status: 'failed', error: 'catalog_stale' };
		const execution = input.execution;
		if (!execution || !input.workspace) return { status: 'unsupported', error: 'execution_not_connected' };
		const generation = String(execution.conversation.generation);
		const previous = object(execution.conversation.nativeState?.value)?.threadId;
		const nativeRef = typeof previous === 'string' ? { sessionId: previous } : undefined;
		// Explicit reset uses the currently prepared persona, never silently resumes an unverified old thread.
		const fresh: SessionInput = { runId: execution.requestId, workspace: input.workspace, systemPrompt: execution.systemPrompt,
			conversation: { ...execution.conversation, nativeState: undefined }, saveRecovery: execution.saveRecovery };
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
			const next = await execution.replaceSession(created.threadId, sessionState(created, input.workspace));
			this.sessions.set(JSON.stringify([execution.conversation.id, next]), Promise.resolve(created));
			return { status: 'completed', generation, nativeRef, effect: { kind: 'reset', sessionId: created.threadId, generation: String(next) },
				text: 'New native Codex thread selected. Previous work and history are retained; no stop is claimed.' };
		} catch {
			let revokeFailed = false;
			if (created) { try { await created.grants.revokeAll(); } catch { revokeFailed = true; } finally { created.channel.close(); } }
			return { status: 'unknown', generation, nativeRef, error: revokeFailed ? 'CODEX_GRANT_REVOKE_FAILED' : 'native_request_failed',
				text: 'Native reset outcome unconfirmed. Retain the recorded thread evidence; do not automatically retry.' };
		}
	}
	async disconnect(): Promise<void> {
		this.discovery?.close();
		await Promise.all([...this.sessions.values()].map(async (pending) => {
			const session = await pending.catch(() => undefined);
			if (session) { try { await session.grants.revokeAll(); } finally { session.channel.close(); } }
		}));
	}
	createRun(input: PreparedRun): AgentRun {
		if (!input.runId || !input.workspace || !input.replyToken || !input.conversation || !input.signal)
			throw new TypeError('Codex native run requires prepared core input');
		return new CodexNativeRun(input, () => this.session(input));
	}
	private async session(input: PreparedRun): Promise<Session> {
		const scope = await prepareCodexScope(input);
		input.conversation.assertCurrent();
		const key = JSON.stringify([input.conversation.id, input.conversation.generation]);
		const existing = this.sessions.get(key);
		if (existing) {
			const session = await existing;
			if (session.scope.digest !== scope.digest || session.threadId !== scope.threadId)
				throw new Error('CODEX_NATIVE_SCOPE_CHANGED: explicit reset required');
			return session;
		}
		const pending = this.open(input, scope).then(async (session) => {
			try {
				if (!input.conversation.registerNative) throw new Error('Codex atomic native registration unavailable');
				await input.conversation.registerNative(session.threadId, sessionState(session, input.workspace!));
				return session;
			} catch (error) { try { await session.grants.revokeAll(); } finally { session.channel.close(); } throw error; }
		});
		// Keep failed admission too: an unknown native start/resume must not be blindly retried.
		this.sessions.set(key, pending);
		return pending;
	}
	private async open(input: SessionInput, scope: Scope): Promise<Session> {
		const grants = await (this.deps.createGrants?.() ?? CodexTurnGrants.create());
		const args = codexHookFlags(codexHookConfig(grants.command()));
		const env = codexNativeEnv(this.deps.env);
		const channel = this.deps.createChannel?.(args, env) ?? new CodexAppServer({ command: this.deps.command, args, env });
		try {
			await channel.start();
			input.conversation.assertCurrent();
			await input.saveRecovery({ version: 1, value: { provider: 'codex', runId: input.runId, threadId: scope.threadId ?? null,
				workspace: input.workspace, stopProbe: 'unknown-after-restart' } });
			input.conversation.assertCurrent();
			const raw = await channel.request(scope.threadId ? 'thread/resume' : 'thread/start', {
				...(scope.threadId ? { threadId: scope.threadId } : {}), cwd: input.workspace,
				developerInstructions: scope.systemPrompt, approvalPolicy: 'never', sandbox: 'danger-full-access',
				...(this.deps.model ? { model: this.deps.model } : {}),
			}, input.runId);
			const response = object(raw), thread = object(response?.thread);
			if (typeof thread?.id !== 'string' || !thread.id || thread.cliVersion !== '0.142.3' ||
				thread.cwd !== input.workspace || (scope.threadId && thread.id !== scope.threadId))
				throw new Error('CODEX_NATIVE_THREAD_UNVERIFIED');
			return { channel, grants, threadId: thread.id, scope };
		} catch (error) { try { await grants.revokeAll(); } finally { channel.close(); } throw error; }
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
	private channelFailure?: string;
	private session?: Session;
	private ref?: NativeRef;
	private wake?: () => void;
	private readonly inbox: Array<{ method: string; params: unknown }> = [];
	constructor(private readonly input: PreparedRun, private readonly getSession: () => Promise<Session>) {}
	get events(): AsyncIterable<AgentEvent> {
		return { [Symbol.asyncIterator]: () => {
			if (this.consumed) throw new Error('Codex native run can be consumed only once');
			this.consumed = true;
			return this.execute();
		} };
	}
	private async *execute(): AsyncGenerator<AgentEvent> {
		const input = this.input, started = Date.now();
		const onAbort = () => { void this.cancel('aborted').catch(() => { this.channelFailure = 'CODEX_GRANT_REVOKE_FAILED'; this.wake?.(); }); };
		let unsubscribe: (() => void) | undefined, offClose: (() => void) | undefined;
		try {
			if (this.cancelled || input.signal.aborted) { yield { type: 'cancelled', reason: 'Cancelled before submission' }; return; }
			if (!input.replyThinkingId) throw new Error('Codex native run requires the exact START-ready reply grant');
			input.signal.addEventListener('abort', onAbort, { once: true });
			const session = this.session = await this.getSession();
			if (this.cancelled || input.signal.aborted) { yield { type: 'cancelled', reason: 'Cancelled before submission' }; return; }
			unsubscribe = session.channel.onNotification((method, params) => {
				if (object(params)?.threadId !== session.threadId || this.channelFailure) return;
				// ponytail: bound per-run buffering; overflow is unknown, never a silently dropped terminal.
				if (this.inbox.length >= 4096) this.channelFailure = 'CODEX_RESULT_UNKNOWN: native event buffer exceeded';
				else this.inbox.push({ method, params });
				this.wake?.();
			});
			offClose = session.channel.onClose(() => { this.channelFailure = 'CODEX_RESULT_UNKNOWN: native channel lost; do not resubmit'; this.wake?.(); });
			input.conversation.assertCurrent();
			await input.saveRecovery({ version: 1, value: { provider: 'codex', runId: input.runId, threadId: session.threadId,
				workspace: input.workspace, stopProbe: 'unknown-after-restart' } });
			input.conversation.assertCurrent();
			if (this.cancelled || input.signal.aborted) { yield { type: 'cancelled', reason: 'Cancelled before submission' }; return; }
			this.submitted = true;
			const raw = await session.channel.request('turn/start', { threadId: session.threadId, clientUserMessageId: input.runId,
				input: [{ type: 'text', text: input.message, text_elements: [] }] });
			const turn = object(object(raw)?.turn);
			if (typeof turn?.id !== 'string' || !turn.id) throw new Error('CODEX_NATIVE_TURN_UNVERIFIED');
			this.ref = { sessionId: session.threadId, turnId: turn.id };
			await input.saveRecovery({ version: 1, value: { provider: 'codex', runId: input.runId, nativeRef: this.ref,
				workspace: input.workspace, stopProbe: 'unknown-after-restart' } });
			input.onNativeBound?.(this.ref);
			input.conversation.assertCurrent();
			if (!this.cancelled) await session.grants.grant(this.ref, input.replyToken!);
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
					await session.grants.revoke(this.ref);
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
			yield { type: 'error', message: error instanceof Error ? error.message : 'CODEX_NATIVE_RUN_FAILED' };
		} finally {
			unsubscribe?.(); offClose?.(); input.signal.removeEventListener('abort', onAbort);
			if (this.ref && this.session) {
				try { await this.session.grants.revoke(this.ref); }
				catch { this.channelFailure = 'CODEX_GRANT_REVOKE_FAILED'; if (!this.cancelled) this.session.channel.close(); }
			}
		}
	}
	async cancel(reason: string): Promise<Awaited<ReturnType<AgentRun['cancel']>>> {
		this.cancelled = true;
		let revokeFailed = false;
		try {
			if (this.ref && this.session) {
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
	async dispose(): Promise<void> { if (!this.terminal) await this.cancel('dispose'); }
}
