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
}
export interface AgentCapabilityCatalog {
	version: string;
	framework: string;
	runtimeVersion: string;
	capabilities: AgentCapability[];
}
export interface AgentCapabilityContext {
	/** Prepared by core from trusted room context, never supplied directly by the UI. */
	workspace?: string;
	signal: AbortSignal;
}
export interface AgentCapabilityInvocation extends AgentCapabilityContext {
	capabilityId: string;
	parameters?: Record<string, unknown>;
	catalogVersion: string;
}
export interface AgentCapabilityResult {
	status: 'completed' | 'failed' | 'unsupported' | 'unknown';
	text?: string;
	nativeResult?: unknown;
	error?: string;
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
