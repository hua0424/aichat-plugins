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

/** Native per-run adapter; only core-owned binding handles may route capabilities. */
export interface AgentDriver {
	readonly type: string;
	readonly features: {
		cancel: 'confirmed' | 'best-effort' | 'unsupported';
		reset: 'supported' | 'unsupported';
		promptUpdate: 'per-run' | 'new-session';
	};
	connect(): Promise<void>;
	createRun(input: PreparedRun): AgentRun;
	disconnect(): Promise<void>;
	/** Preserve provider-specific thinking presentation without an identity-routing branch. */
	finalizeThinking?(content: string): string;
}

/** Source-compatible name while callers migrate to the unified AgentDriver contract. */
export type RunDriver = AgentDriver;
