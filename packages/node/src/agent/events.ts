/**
 * REQ-008 #75 — Normalized agent abstraction.
 *
 * AgentEvent is the driver-agnostic event vocabulary every AgentDriver emits.
 * Concrete drivers (e.g. OpenclawDriver) translate their backend's wire/callback
 * shape into this stream; the MessageHandler consumes ONLY AgentEvents, so the
 * HuLa-side mapping logic is decoupled from any particular agent backend.
 */
export type AgentEvent =
	| { type: 'thinking'; text: string }
	| { type: 'tool'; name: string; phase: 'start' | 'end' }
	| { type: 'done'; durationMs: number; usage?: Record<string, unknown> }
	| { type: 'error'; message: string }
	| { type: 'cancelled'; reason: string };

/**
 * #382 — error-message prefix a driver stamps when a live run PROVED a persisted native session
 * non-resumable at runtime (CC `--resume` failing with `No conversation found`: native history lost).
 * The bridge keys client-visible failure feedback and the explainable pause on this same code,
 * so the thinking-table trace (status=2 error string) and the room notice always agree.
 */
export const NATIVE_SESSION_LOST = 'native_session_lost';

/** Core-owned, generation-bound handles; these methods must reject stale writes. */
export interface BoundConversation {
	readonly id: string;
	readonly generation: number;
	readonly nativeState: { version: number; value: unknown } | undefined;
	/** Core's synchronous generation gate, callable without native or network side effects. */
	assertCurrent(): void;
	saveNativeState(value: { version: number; value: unknown }): Promise<void>;
	registerNativeAlias(alias: { scope?: string; id: string }): Promise<void>;
	/** Atomically bind the native ID and state in the core snapshot. */
	registerNative?(id: string, state: { version: number; value: unknown }): Promise<void>;
}

/** A capability handle bound by the core, never a server API client or routing DTO. */
export interface BoundCapabilityChannel {
	invoke(command: string, args: Record<string, unknown>, requestId?: string): Promise<unknown>;
}

export interface PreparedRun {
	runId: string;
	message: string;
	workspace?: string;
	/** Opaque core capability key, never inferred from a native session or server DTO. */
	contextKey?: string;
	/** Core-validated identity owning a shared native prompt scope; never parsed from a native key. */
	promptOwner?: string;
	/** Existing imported CC bind alias or the newly minted core alias; CLI candidates must agree. */
	bindToken?: string;
	/**
	 * #404: frozen opaque reply-binding token for this run (AICHAT_RUN_BIND value), minted and
	 * persisted by core at beginRun and fixed to one thinkingId by the exact START receipt before
	 * native submission. CC/Codex drivers inject it verbatim into the per-run execution env.
	 */
	replyToken?: string;
	replyThinkingId?: string;
	selectedModel?: { providerID: string; modelID: string };
	getSelectedModel?(): { providerID: string; modelID: string } | undefined;
	onNativeBound?(ref: NativeRef): void;
	/** Core verifies an already-submitted native turn's original START-ready reply lease, including detached generations. */
	assertReplySettlement?(ref: NativeRef): void;
	/** Legacy transcript file key only; not an authorization source. */
	transcriptKey?: string;
	systemPrompt: string;
	conversation: BoundConversation;
	saveRecovery(value: { version: number; value: unknown }): Promise<void>;
	capabilities: BoundCapabilityChannel;
	signal: AbortSignal;
}

export interface AgentRun {
	readonly events: AsyncIterable<AgentEvent>;
	cancel(reason: string): Promise<
		| { status: 'stopped' }
		| { status: 'unsupported' }
		| { status: 'unconfirmed'; reason: string }
	>;
	dispose(): Promise<void>;
}

/** Read-only native discovery is separate from chat runs and core's send-message capabilities. */
export interface AgentCapability {
	id: string;
	kind: 'model' | 'skill' | 'command';
	name: string;
	description?: string;
	supported: boolean;
	executable: boolean;
	reason?: string;
	defaultVisibility: 'public' | 'hidden';
	scope: 'workspace' | 'conversation' | 'instance';
	parameters: Array<{ name: string; type: string; required: boolean }>;
	source?: 'skill' | 'command' | 'mcp' | 'model' | 'session';
}
export interface AgentCapabilityCatalog {
	version: string;
	framework: string;
	runtimeVersion: string;
	capabilities: AgentCapability[];
	models?: { items: { providerId: string; modelId: string; label: string; connected: boolean }[]; total: number; offset: number; nextOffset?: number };
}
export interface AgentCapabilityContext {
	/** Prepared by core from trusted room context, never supplied directly by the UI. */
	workspace?: string;
	signal: AbortSignal;
	capabilityId?: string;
	parameters?: Record<string, unknown>;
}
export interface AgentCapabilityInvocation extends AgentCapabilityContext {
	capabilityId: string;
	parameters?: Record<string, unknown>;
	catalogVersion: string;
	execution?: CapabilityExecution;
	/** Core journal only. Presence selects read-only reconciliation; never a submission fallback. */
	recovery?: { generation: number; nativeRef?: NativeRef; receipt: AgentCapabilityResult; value?: { version: number; value: unknown } };
}
export interface NativeRef { sessionId: string; inputId?: string; messageId?: string; parentId?: string; turnId?: string }
export type CapabilityEffect =
	| { kind: 'reset'; sessionId: string; generation: string }
	| { kind: 'compact'; controlId: string; summaryId?: string; summary: boolean }
	| { kind: 'model'; providerId: string; modelId: string; effective: 'next_request' };
export interface AgentCapabilityResult {
	status: 'accepted' | 'completed' | 'failed' | 'noop' | 'unsupported' | 'unknown';
	text?: string;
	nativeResult?: unknown;
	error?: string;
	phase?: 'accepted' | 'outcome' | 'generation';
	generation?: string;
	nativeRef?: NativeRef;
	effect?: CapabilityEffect;
	reconciled?: boolean;
}
export interface NativeTurnEvent {
	eventId: string; conversationId: string; generation: number; nativeRef: NativeRef;
	requestIds: string[]; relation: 'new' | 'attached'; phase: 'bound' | 'completed' | 'failed' | 'cancelled';
	event?: AgentEvent;
}
export interface CapabilityExecution {
	requestId: string; conversation: BoundConversation; systemPrompt: string; contextKey: string;
	promptOwner: string; authorizationEpoch: string;
	selectedModel?: { providerID: string; modelID: string };
	getSelectedModel?(): { providerID: string; modelID: string } | undefined;
	saveRecovery(value: { version: number; value: unknown }): Promise<void>;
	/** Persist native locator BEFORE the native mutation. */
	submitted(ref?: NativeRef): Promise<void>;
	selectModel(model: { providerID: string; modelID: string }): Promise<void>;
	replaceSession(id: string, state: { version: number; value: unknown }): Promise<number>;
	emit(event: { type: 'receipt'; receipt: AgentCapabilityResult } | { type: 'turn'; turn: NativeTurnEvent }): Promise<void>;
	/** Returned only after the exact native unit's START receipt confirms its thinking target. */
	bindTurn(turn: NativeTurnEvent): Promise<{ token: string; runId: string; thinkingId: string }>;
}

/** Native per-run adapter; only core-owned binding handles may route capabilities. */
export interface AgentDriver {
	readonly type: string;
	readonly features: {
		cancel: 'confirmed' | 'best-effort' | 'unsupported';
		reset: 'supported' | 'unsupported';
		promptUpdate: 'per-run' | 'new-session';
	};
	connect(): Promise<void>;
	/** Absence means unsupported; never infer support from the framework name. */
	discoverCapabilities?(input: AgentCapabilityContext): Promise<AgentCapabilityCatalog>;
	executeCapability?(input: AgentCapabilityInvocation): Promise<AgentCapabilityResult>;
	createRun(input: PreparedRun): AgentRun;
	disconnect(): Promise<void>;
	/** Preserve provider-specific thinking presentation without an identity-routing branch. */
	finalizeThinking?(content: string): string;
}

/** Source-compatible name while callers migrate to the unified AgentDriver contract. */
export type RunDriver = AgentDriver;
