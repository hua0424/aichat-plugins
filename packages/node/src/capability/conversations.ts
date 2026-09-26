import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bindingKey, parseBindingKey } from '../agent/bind-token-store.js';
import { parseSessionKey } from './session-key.js';

export type Provider = 'openclaw' | 'cc' | 'codex' | 'opencode';
export type ContextCandidate = { key: string } | { provider: Provider; nativeId: string; runtimeScope?: string };
export interface NativeAlias { provider: Provider; id: string; runtimeScope?: string }
export interface ConversationRecord {
	conversationId: string;
	serverNamespace: string;
	identityId: string;
	roomId: string;
	adapterInstanceId: string;
	generation: number;
	contextKey: string;
	state: 'ready' | 'suspended' | 'stop_unconfirmed' | 'disabled';
	/** A reset can leave several older runs awaiting independent stop confirmation. */
	pendingRuns?: PendingRun[];
	nativeAliases: NativeAlias[];
	/** Original provider store payloads. OpenClaw retains both the bare token and full gateway sessionKey. */
	nativeState: Partial<Record<Provider, Record<string, unknown>>>;
}
export interface RecoveryData { version: number; value: unknown }
export interface PendingRun { runId: string; generation: number; startedAt: string; recovery?: RecoveryData }
export interface BoundConversationRun {
	readonly conversationId: string;
	readonly generation: number;
	readonly contextKey: string;
	readonly nativeState: ConversationRecord['nativeState'];
	/** Synchronous, side-effect-free gate checked immediately before native submission. */
	assertCurrent(): void;
	saveNativeState(provider: Provider, state: Record<string, unknown>): void;
	registerNativeAlias(provider: Provider, id: string, runtimeScope?: string): void;
	registerNative(provider: Provider, id: string, state?: Record<string, unknown>, runtimeScope?: string): void;
	saveRecovery(value: RecoveryData): void;
}
export interface ResetReceipt { reset: true; generation: number; executionPaused: boolean }
interface StoredResetReceipt { digest: string; receipt: ResetReceipt }
interface Snapshot { version: 1; sources: Record<string, string>; records: ConversationRecord[]; revokedKeys?: string[]; revokedAliases?: NativeAlias[]; resetReceipts?: StoredResetReceipt[] }
export interface ConversationStoreOptions {
	home: string;
	serverNamespace: string;
	activeUids: ReadonlySet<string>;
	/** Required to assign a legacy bind-token to exactly one provider; never guess CC vs OpenClaw. */
	activeProviders?: ReadonlyMap<string, Provider>;
	/** Injectable disk failure before rename; used to prove no uncommitted binding becomes visible. */
	beforePersist?: () => void;
}
const PROVIDERS = new Set<Provider>(['openclaw', 'cc', 'codex', 'opencode']);
const LEGACY = ['bind-tokens.json', 'opencode/sessions.json', 'codex/sessions.json', 'cc/sessions.json'] as const;
const validId = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 4096;
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const identityKey = (ns: string, uid: string, room: string): string => JSON.stringify([ns, uid, room]);
const aliasKey = (a: NativeAlias): string => JSON.stringify([a.provider, a.runtimeScope ?? '', a.id]);
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** One synchronous, atomic JSON writer; callers must hold the one-process-per-home lease before construction. */
export class ConversationStore {
	private readonly path: string;
	private snapshot: Snapshot;
	private readonly byIdentity = new Map<string, ConversationRecord>();
	private readonly byKey = new Map<string, ConversationRecord>();
	private readonly byAlias = new Map<string, ConversationRecord>();
	private closed = false;

	constructor(private readonly options: ConversationStoreOptions) {
		if (!validId(options.serverNamespace)) throw new Error('serverNamespace required');
		this.path = join(options.home, 'conversations.json');
		const existing = existsSync(this.path);
		if (existing) {
			this.snapshot = this.readSnapshot();
			this.verifySources(this.snapshot.sources);
		} else {
			this.snapshot = this.importLegacy();
			this.persist(this.snapshot);
		}
		this.index(this.snapshot);
		if (existing && Object.keys(this.snapshot.sources).length) {
			// An identity may have been disabled during the first upgrade. Import its untouched
			// backup only after activation; never make inactive legacy credentials addressable.
			const newlyActive = this.importLegacy();
			if (JSON.stringify(newlyActive.sources) !== JSON.stringify(this.snapshot.sources))
				throw new Error('legacy sources changed after migration');
			const missing = newlyActive.records.filter((r) => !this.byIdentity.has(identityKey(r.serverNamespace, r.identityId, r.roomId)));
			if (missing.length) this.commit([...this.snapshot.records, ...missing]);
		}
		// A process restart is not evidence that a native run stopped. Persist the gate before admission.
		if (this.snapshot.records.some((r) => r.pendingRuns?.length && r.state !== 'stop_unconfirmed')) {
			this.commit(this.snapshot.records.map((r) => r.pendingRuns?.length ? { ...r, state: 'stop_unconfirmed' } : r));
		}
	}

	/** Stop accepting late driver writes before releasing the single-writer lease. */
	close(): void { this.closed = true; }

	get(identityId: string, roomId: string): ConversationRecord | undefined {
		const record = this.byIdentity.get(identityKey(this.options.serverNamespace, identityId, roomId));
		return record ? copy(record) : undefined;
	}

	getOrCreate(identityId: string, roomId: string): ConversationRecord {
		if (this.closed) throw new Error('conversation store closed');
		this.assertActive(identityId);
		if (!validId(roomId)) throw new Error('invalid roomId');
		const previous = this.get(identityId, roomId);
		if (previous) {
			if (this.options.activeProviders?.has(identityId) && previous.adapterInstanceId !== this.options.activeProviders.get(identityId))
				throw new Error('activated provider changed for existing conversation');
			return previous;
		}
		const record: ConversationRecord = {
			conversationId: randomUUID(), serverNamespace: this.options.serverNamespace,
			identityId, roomId, adapterInstanceId: this.options.activeProviders?.get(identityId) ?? identityId,
			generation: 1, contextKey: randomBytes(32).toString('hex'), state: 'ready',
			nativeAliases: [], nativeState: {},
		};
		this.commit([...this.snapshot.records, record]);
		return copy(record);
	}

	/** A short synchronous transaction; no driver or network operation runs while changing the binding. */
	reset(identityId: string, roomId: string, requestId?: string, bearer?: string): ConversationRecord {
		if ((requestId === undefined) !== (bearer === undefined)) throw new Error('reset receipt requires requestId and bearer');
		let receiptDigest: string | undefined;
		if (requestId !== undefined && bearer !== undefined) {
			receiptDigest = this.receiptDigest(bearer, requestId);
			if (this.snapshot.resetReceipts?.some((r) => r.digest === receiptDigest)) throw new Error('duplicate reset requestId');
			// ponytail: fail closed after 1024 lifetime reset receipts rather than evict a still-retriable
			// revoked bearer; add durable expiry/compaction with an explicit retry window before raising this ceiling.
			if ((this.snapshot.resetReceipts?.length ?? 0) >= 1024) throw new Error('reset receipt capacity exceeded');
		}
		const old = this.get(identityId, roomId) ?? this.newRecord(identityId, roomId);
		if (this.options.activeProviders?.has(identityId) && old.adapterInstanceId !== this.options.activeProviders.get(identityId))
			throw new Error('activated provider changed for existing conversation');
		if (!Number.isSafeInteger(old.generation + 1)) throw new Error('generation exhausted');
		const record: ConversationRecord = { ...old, generation: old.generation + 1,
			contextKey: randomBytes(32).toString('hex'), nativeAliases: [], nativeState: {},
			state: old.pendingRuns?.length || old.state === 'stop_unconfirmed' ? 'stop_unconfirmed' : old.state };
		const records = this.snapshot.records.some((r) => r.conversationId === old.conversationId)
			? this.snapshot.records.map((r) => r.conversationId === old.conversationId ? record : r)
			: [...this.snapshot.records, record];
		this.commit(records, {
			revokedKeys: [...(this.snapshot.revokedKeys ?? []), old.contextKey],
			revokedAliases: [...(this.snapshot.revokedAliases ?? []), ...old.nativeAliases],
			...(receiptDigest ? { resetReceipts: [...(this.snapshot.resetReceipts ?? []), {
				digest: receiptDigest, receipt: { reset: true as const, generation: record.generation,
					executionPaused: record.state !== 'ready' },
			}] } : {}),
		});
		return copy(record);
	}

	getResetReceipt(bearer: string, requestId: string): ResetReceipt | undefined {
		const digest = this.receiptDigest(bearer, requestId);
		const entry = this.snapshot.resetReceipts?.find((r) => r.digest === digest);
		return entry ? copy(entry.receipt) : undefined;
	}

	private receiptDigest(bearer: string, requestId: string): string {
		if (!validId(requestId) || requestId.length > 256 || typeof bearer !== 'string' || !bearer.length || bearer.length > 8192)
			throw new Error('invalid reset receipt binding');
		return createHash('sha256').update(JSON.stringify([bearer, requestId])).digest('hex');
	}

	beginRun(identityId: string, roomId: string, runId: string): BoundConversationRun {
		if (!validId(runId)) throw new Error('invalid runId');
		const record = this.getOrCreate(identityId, roomId);
		if (record.state !== 'ready' || record.pendingRuns?.length) throw new Error('conversation paused or occupied');
		if (this.snapshot.records.some((r) => r.pendingRuns?.some((run) => run.runId === runId))) throw new Error('duplicate runId');
		record.pendingRuns = [{ runId, generation: record.generation, startedAt: new Date().toISOString() }];
		this.replace(record);
		const generation = record.generation, conversationId = record.conversationId;
		const current = (): ConversationRecord => {
			const r = this.byIdentity.get(identityKey(this.options.serverNamespace, identityId, roomId));
			if (this.closed || !r || r.conversationId !== conversationId || r.generation !== generation ||
				!r.pendingRuns?.some((run) => run.runId === runId)) throw new Error('STALE_GENERATION');
			if (r.state !== 'ready') throw new Error('conversation paused');
			return r;
		};
		return {
			conversationId, generation, contextKey: record.contextKey, nativeState: copy(record.nativeState),
			assertCurrent: () => { current(); },
			saveNativeState: (provider, state) => {
				current(); this.assertProvider(provider, identityId);
				if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('invalid native state');
				const updated = copy(current()); updated.nativeState[provider] = copy(state); this.replace(updated);
			},
			registerNativeAlias: (provider, id, runtimeScope) => {
				current(); this.registerNative(provider, id, identityId, roomId, undefined, runtimeScope);
			},
			registerNative: (provider, id, state, runtimeScope) => {
				current(); this.registerNative(provider, id, identityId, roomId, state, runtimeScope);
			},
			saveRecovery: (value) => this.saveRecovery(runId, value),
		};
	}

	pendingRuns(): Array<PendingRun & { conversationId: string; identityId: string; roomId: string }> {
		return this.snapshot.records.flatMap((r) => (r.pendingRuns ?? []).map((run) =>
			({ ...copy(run), conversationId: r.conversationId, identityId: r.identityId, roomId: r.roomId })));
	}

	saveRecovery(runId: string, value: RecoveryData): void {
		this.assertRecovery(value);
		const record = this.snapshot.records.find((r) => r.pendingRuns?.some((run) => run.runId === runId));
		if (!record || this.closed) throw new Error('run no longer pending');
		const updated = copy(record);
		updated.pendingRuns!.find((run) => run.runId === runId)!.recovery = copy(value);
		this.replace(updated);
	}

	markCancelling(runId: string): void { this.updateRunState(runId, 'suspended'); }
	markStopUnconfirmed(runId: string): void { this.updateRunState(runId, 'stop_unconfirmed'); }
	confirmStopped(runId: string): void { this.finishRun(runId); }
	finishRun(runId: string): void {
		const record = this.snapshot.records.find((r) => r.pendingRuns?.some((run) => run.runId === runId));
		if (!record || this.closed) throw new Error('run no longer pending');
		const updated = copy(record);
		updated.pendingRuns = updated.pendingRuns!.filter((run) => run.runId !== runId);
		updated.state = updated.pendingRuns.length ? 'stop_unconfirmed' : 'ready';
		this.replace(updated);
	}
	private updateRunState(runId: string, state: 'suspended' | 'stop_unconfirmed'): void {
		const record = this.snapshot.records.find((r) => r.pendingRuns?.some((run) => run.runId === runId));
		if (!record || this.closed) throw new Error('run no longer pending');
		this.replace({ ...copy(record), state });
	}
	private assertRecovery(value: RecoveryData): void {
		if (!value || !Number.isSafeInteger(value.version) || value.version < 1) throw new Error('invalid recovery');
		let encoded: string | undefined;
		try { encoded = JSON.stringify(value); } catch { /* cyclic */ }
		if (!encoded || Buffer.byteLength(encoded) > 65536 || JSON.stringify(JSON.parse(encoded)) !== encoded)
			throw new Error('invalid recovery');
	}

	contextKey(identityId: string, roomId: string): string { return this.getOrCreate(identityId, roomId).contextKey; }

	registerNative(provider: Provider, id: string, identityId: string, roomId: string,
		nativeState?: Record<string, unknown>, runtimeScope?: string): ConversationRecord {
		this.assertProvider(provider, identityId);
		if (!validId(id) || (runtimeScope !== undefined && !validId(runtimeScope))) throw new Error('invalid native alias');
		const prior = this.get(identityId, roomId);
		if (prior && (prior.state !== 'ready' || prior.pendingRuns?.some((run) => run.generation !== prior.generation)))
			throw new Error('conversation paused');
		if (prior && this.options.activeProviders?.has(identityId) && prior.adapterInstanceId !== this.options.activeProviders.get(identityId))
			throw new Error('activated provider changed for existing conversation');
		const record = prior ?? this.newRecord(identityId, roomId);
		// Claude's sessionId restores --resume but is NOT a CLI capability credential. Only its bind token is.
		if (provider === 'cc' && nativeState && 'sessionId' in nativeState) {
			if (nativeState.sessionId !== id || Object.keys(nativeState).some((k) => k !== 'sessionId')) throw new Error('invalid CC native state');
			if (this.snapshot.records.some((r) => r.conversationId !== record.conversationId && r.nativeState.cc?.sessionId === id)) {
				throw new Error('duplicate CC native session');
			}
			record.nativeState.cc = copy(nativeState);
			this.replace(record);
			return copy(record);
		}
		const alias: NativeAlias = { provider, id, ...(runtimeScope === undefined ? {} : { runtimeScope }) };
		if (this.snapshot.revokedAliases?.some((a) => aliasKey(a) === aliasKey(alias))) throw new Error('native alias revoked');
		const other = this.byAlias.get(aliasKey(alias));
		if (other && (other.conversationId !== record.conversationId || other.generation !== record.generation)) {
			throw new Error('native alias conflict');
		}
		// A driver may replace a dead native session or change workspace; revoke the old alias
		// in this SAME atomic commit, never leave a half-deleted binding on a failed write.
		record.nativeAliases = record.nativeAliases.filter((a) =>
			a.provider !== provider || (a.runtimeScope ?? '') !== (runtimeScope ?? '') || a.id === id);
		if (!record.nativeAliases.some((a) => aliasKey(a) === aliasKey(alias))) record.nativeAliases.push(alias);
		if (nativeState !== undefined) {
			if (!nativeState || typeof nativeState !== 'object' || Array.isArray(nativeState)) throw new Error('invalid native state');
			record.nativeState[provider] = copy(nativeState);
		}
		this.replace(record);
		return copy(record);
	}

	getNative(provider: Provider, identityId: string, roomId: string): Record<string, unknown> | undefined {
		const state = this.get(identityId, roomId)?.nativeState[provider];
		return state && Object.keys(state).length ? copy(state) : undefined;
	}

	/** Stable agent-facing bind token; the core key itself works for newly created rooms. */
	mintToken(identityId: string, roomId: string): string {
		this.assertActive(identityId);
		const provider = this.options.activeProviders?.get(identityId);
		if (provider !== 'openclaw' && provider !== 'cc') throw new Error('bind token requires an activated CC/OpenClaw identity');
		const record = this.getOrCreate(identityId, roomId);
		if (record.state !== 'ready' || record.pendingRuns?.some((run) => run.generation !== record.generation))
			throw new Error('conversation paused');
		const current = record.nativeAliases.find((alias) => alias.provider === provider);
		if (current) return current.id;
		const token = record.contextKey;
		const state = provider === 'openclaw' ? { token, nativeRef: `${token}:${bindingKey(identityId, roomId)}` } : undefined;
		this.registerNative(provider, token, identityId, roomId, state);
		return token;
	}

	resolveToken(provider: Provider, token: string): ConversationRecord | undefined {
		if ((provider !== 'openclaw' && provider !== 'cc') || !validId(token)) return undefined;
		return this.resolveCandidate({ provider, nativeId: token.toLowerCase() });
	}

	findNative(provider: Provider, id: string, runtimeScope?: string): ConversationRecord | undefined {
		return this.resolveCandidate({ provider, nativeId: id, ...(runtimeScope === undefined ? {} : { runtimeScope }) });
	}

	deleteNative(provider: Provider, identityId: string, roomId: string): void {
		this.assertProvider(provider, identityId);
		const record = this.get(identityId, roomId);
		if (record && (record.state !== 'ready' || record.pendingRuns?.some((run) => run.generation !== record.generation)))
			throw new Error('conversation paused');
		if (!record || (!record.nativeState[provider] && !record.nativeAliases.some((a) => a.provider === provider))) return;
		// CC delete means forget the resumable session, not the stable agent-facing bind token.
		if (provider === 'cc' && !record.nativeState.cc) return;
		delete record.nativeState[provider];
		if (provider !== 'cc') record.nativeAliases = record.nativeAliases.filter((a) => a.provider !== provider);
		this.replace(record);
	}

	resolveCandidate(candidate: ContextCandidate): ConversationRecord | undefined {
		if ('key' in candidate) return validId(candidate.key) ? this.visible(this.byKey.get(candidate.key)) : undefined;
		if (!PROVIDERS.has(candidate.provider) || !validId(candidate.nativeId)) return undefined;
		if (candidate.runtimeScope !== undefined) return this.visible(this.byAlias.get(aliasKey({
			provider: candidate.provider, id: candidate.nativeId, runtimeScope: candidate.runtimeScope,
		})));
		// Unscoped legacy requests are valid only when their native ID has exactly one matching scope.
		const matches = this.snapshot.records.flatMap((r) => r.nativeAliases
			.filter((a) => a.provider === candidate.provider && a.id === candidate.nativeId).map(() => r));
		return matches.length === 1 ? this.visible(matches[0]) : undefined;
	}

	resolveCandidates(candidates: readonly ContextCandidate[]): ConversationRecord | undefined {
		if (!candidates.length || candidates.length > 8) return undefined;
		let found: ConversationRecord | undefined;
		for (const candidate of candidates) {
			const record = this.resolveCandidate(candidate);
			if (!record || (found && (record.conversationId !== found.conversationId || record.generation !== found.generation))) return undefined;
			found = record;
		}
		return found;
	}

	resolveLegacy(sessionKey: string): ConversationRecord | undefined {
		const parsed = parseSessionKey(sessionKey);
		return parsed && PROVIDERS.has(parsed.agentType as Provider)
			? this.resolveCandidate({ provider: parsed.agentType as Provider, nativeId: parsed.id }) : undefined;
	}

	private visible(record: ConversationRecord | undefined): ConversationRecord | undefined {
		return record && this.options.activeUids.has(record.identityId) &&
			(!this.options.activeProviders?.has(record.identityId) ||
				this.options.activeProviders.get(record.identityId) === record.adapterInstanceId) ? copy(record) : undefined;
	}

	private newRecord(uid: string, room: string): ConversationRecord {
		this.assertActive(uid);
		if (!validId(room)) throw new Error('invalid roomId');
		return { conversationId: randomUUID(), serverNamespace: this.options.serverNamespace,
			identityId: uid, roomId: room, adapterInstanceId: this.options.activeProviders?.get(uid) ?? uid,
			generation: 1, contextKey: randomBytes(32).toString('hex'), state: 'ready', nativeAliases: [], nativeState: {} };
	}

	private assertActive(uid: string): void {
		if (!validId(uid) || !this.options.activeUids.has(uid)) throw new Error('identity not activated');
	}
	private assertProvider(provider: Provider, uid: string): void {
		this.assertActive(uid);
		if (!PROVIDERS.has(provider) || (this.options.activeProviders?.has(uid) && this.options.activeProviders.get(uid) !== provider)) {
			throw new Error('provider does not own activated identity');
		}
	}
	private replace(record: ConversationRecord): void {
		const records = this.snapshot.records.filter((r) => r.conversationId !== record.conversationId);
		this.commit([...records, record]);
	}
	private commit(records: ConversationRecord[], additions: Partial<Snapshot> = {}): void {
		if (this.closed) throw new Error('conversation store closed');
		const next: Snapshot = { ...this.snapshot, ...additions, records };
		this.validate(next);
		this.persist(next);
		this.snapshot = next;
		this.index(next);
	}

	private readSnapshot(): Snapshot {
		const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Snapshot;
		this.validate(raw);
		if (process.platform !== 'win32') chmodSync(this.path, 0o600);
		return raw;
	}
	private validate(data: Snapshot): void {
		if (!data || data.version !== 1 || !Array.isArray(data.records) || !data.sources ||
			typeof data.sources !== 'object' || Array.isArray(data.sources)) throw new Error('invalid conversation snapshot');
		if (data.resetReceipts !== undefined && (!Array.isArray(data.resetReceipts) || data.resetReceipts.length > 1024 ||
			new Set(data.resetReceipts.map((r) => r?.digest)).size !== data.resetReceipts.length ||
			data.resetReceipts.some((r) => !r || typeof r.digest !== 'string' || !/^[0-9a-f]{64}$/.test(r.digest) ||
				!r.receipt || r.receipt.reset !== true || !Number.isSafeInteger(r.receipt.generation) ||
				r.receipt.generation < 2 || typeof r.receipt.executionPaused !== 'boolean')))
			throw new Error('invalid reset receipts');
		if (data.revokedKeys !== undefined && (!Array.isArray(data.revokedKeys) || data.revokedKeys.some((k) => typeof k !== 'string' || !/^[0-9a-f]{64}$/.test(k)))) throw new Error('invalid revoked keys');
		if (data.revokedAliases !== undefined && (!Array.isArray(data.revokedAliases) || data.revokedAliases.some((a) => !a || !PROVIDERS.has(a.provider) || !validId(a.id) || (a.runtimeScope !== undefined && !validId(a.runtimeScope))))) throw new Error('invalid revoked aliases');
		const ids = new Set<string>(), keys = new Set(data.revokedKeys ?? []), pairs = new Set<string>(),
			aliases = new Set((data.revokedAliases ?? []).map(aliasKey)), ccSessions = new Set<string>(), runs = new Set<string>();
		if (keys.size !== (data.revokedKeys?.length ?? 0) || aliases.size !== (data.revokedAliases?.length ?? 0)) throw new Error('duplicate revoked binding');
		for (const r of data.records) {
			if (!r || r.serverNamespace !== this.options.serverNamespace || !validId(r.identityId) || !validId(r.roomId) ||
				!validId(r.conversationId) || !validId(r.adapterInstanceId) || !/^[0-9a-f]{64}$/.test(r.contextKey) ||
				!Number.isSafeInteger(r.generation) || r.generation < 1 || !['ready', 'suspended', 'stop_unconfirmed', 'disabled'].includes(r.state) ||
				!Array.isArray(r.nativeAliases) || !r.nativeState || typeof r.nativeState !== 'object' || Array.isArray(r.nativeState) ||
				(r.pendingRuns !== undefined && !Array.isArray(r.pendingRuns))) throw new Error('invalid conversation record');
			for (const run of r.pendingRuns ?? []) {
				if (!run || !validId(run.runId) || runs.has(run.runId) || !Number.isSafeInteger(run.generation) ||
					run.generation < 1 || run.generation > r.generation || !validId(run.startedAt) || Number.isNaN(Date.parse(run.startedAt)))
					throw new Error('invalid pending run');
				if (run.recovery !== undefined) this.assertRecovery(run.recovery);
				runs.add(run.runId);
			}
			if (r.state === 'ready' && r.pendingRuns?.some((run) => run.generation !== r.generation)) throw new Error('old run cannot be ready');
			const pair = identityKey(r.serverNamespace, r.identityId, r.roomId);
			if (ids.has(r.conversationId) || keys.has(r.contextKey) || pairs.has(pair)) throw new Error('duplicate conversation binding');
			ids.add(r.conversationId); keys.add(r.contextKey); pairs.add(pair);
			for (const alias of r.nativeAliases) {
				if (!alias || !PROVIDERS.has(alias.provider) || !validId(alias.id) ||
					(alias.runtimeScope !== undefined && !validId(alias.runtimeScope))) throw new Error('invalid native alias');
				const key = aliasKey(alias);
				if (aliases.has(key)) throw new Error('duplicate native alias');
				aliases.add(key);
			}
			for (const [provider, value] of Object.entries(r.nativeState)) {
				if (!PROVIDERS.has(provider as Provider) || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid native state');
				const state = value as Record<string, unknown>;
				if (provider === 'opencode' && (!validId(state.sessionID) || !validId(state.directory))) throw new Error('invalid opencode native state');
				if (provider === 'codex' && !validId(state.threadId)) throw new Error('invalid codex native state');
				if (provider === 'cc' && state.sessionId !== undefined && !validId(state.sessionId)) throw new Error('invalid CC native state');
				if (provider === 'openclaw' && (!validId(state.token) ||
					state.nativeRef !== `${state.token}:${bindingKey(r.identityId, r.roomId)}`)) throw new Error('invalid OpenClaw nativeRef');
			}
			const ccId = r.nativeState.cc?.sessionId;
			if (ccId !== undefined) {
				if (!validId(ccId) || ccSessions.has(ccId)) throw new Error('duplicate or invalid CC native session');
				ccSessions.add(ccId);
			}
		}
	}
	private index(data: Snapshot): void {
		this.byIdentity.clear(); this.byKey.clear(); this.byAlias.clear();
		for (const r of data.records) {
			this.byIdentity.set(identityKey(r.serverNamespace, r.identityId, r.roomId), r);
			this.byKey.set(r.contextKey, r);
			for (const alias of r.nativeAliases) this.byAlias.set(aliasKey(alias), r);
		}
	}
	private persist(data: Snapshot): void {
		mkdirSync(this.options.home, { recursive: true, mode: 0o700 });
		const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
		try {
			this.options.beforePersist?.();
			writeFileSync(temp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
			// The 0600 temporary file keeps its mode across the atomic replacement.
			renameSync(temp, this.path);
		} catch (error) {
			try { unlinkSync(temp); } catch { /* no temp was created, or cleanup cannot supersede original failure */ }
			throw error;
		}
	}

	private verifySources(sources: Record<string, string>): void {
		for (const rel of LEGACY) {
			const expected = sources[rel];
			if (expected !== undefined) {
				const path = join(this.options.home, rel);
				if (!existsSync(path) || digest(readFileSync(path)) !== expected) throw new Error(`legacy source changed after migration: ${rel}`);
				const backup = join(this.options.home, 'conversation-backups', `${rel.replaceAll('/', '-')}.bak`);
				if (!existsSync(backup) || digest(readFileSync(backup)) !== expected) throw new Error(`migration backup missing or changed: ${rel}`);
			}
		}
	}

	private importLegacy(): Snapshot {
		const sources: Record<string, string> = {};
		const maps = new Map<string, Record<string, unknown>>();
		for (const rel of LEGACY) {
			const path = join(this.options.home, rel);
			if (!existsSync(path)) continue;
			const bytes = readFileSync(path);
			const value: unknown = JSON.parse(bytes.toString('utf8'));
			if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid legacy map: ${rel}`);
			sources[rel] = digest(bytes);
			maps.set(rel, value as Record<string, unknown>);
		}
		const records: ConversationRecord[] = [];
		const get = (uid: string, room: string): ConversationRecord => {
			let record = records.find((r) => r.identityId === uid && r.roomId === room);
			if (!record) { record = this.newRecord(uid, room); records.push(record); }
			return record;
		};
		const seenNative = new Set<string>();
		const attach = (provider: Provider, uid: string, room: string, id: string, state: Record<string, unknown>): void => {
			const a: NativeAlias = { provider, id };
			const key = aliasKey(a);
			if (seenNative.has(key)) throw new Error('duplicate legacy native alias');
			seenNative.add(key);
			if (!this.options.activeUids.has(uid)) return; // inactive legacy data never grants a capability
			this.assertProvider(provider, uid);
			const record = get(uid, room);
			if (record.nativeState[provider]) throw new Error('duplicate legacy provider binding');
			record.nativeAliases.push(a);
			record.nativeState[provider] = state;
		};
		const tokens = maps.get('bind-tokens.json') ?? {};
		const seenTokens = new Set<string>();
		const seenPair = new Set<string>();
		for (const [original, raw] of Object.entries(tokens)) {
			if (!/^[0-9a-fA-F]{64}$/.test(original) || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid legacy bind token');
			const data = raw as Record<string, unknown>;
			if (!validId(data.aiclawUid) || !validId(data.roomId)) throw new Error('invalid legacy bind token binding');
			const token = original.toLowerCase();
			const pair = identityKey(this.options.serverNamespace, data.aiclawUid, data.roomId);
			if (seenTokens.has(token) || seenPair.has(pair)) throw new Error('duplicate legacy bind token');
			seenTokens.add(token); seenPair.add(pair);
			if (!this.options.activeUids.has(data.aiclawUid)) continue;
			const provider = this.options.activeProviders?.get(data.aiclawUid);
			if (provider !== 'openclaw' && provider !== 'cc') throw new Error('active legacy bind token has ambiguous provider');
			const nativeRef = `${token}:${bindingKey(data.aiclawUid, data.roomId)}`;
			attach(provider, data.aiclawUid, data.roomId, token,
				provider === 'openclaw' ? { token, nativeRef } : {});
		}
		for (const [rel, provider, field] of [
			['opencode/sessions.json', 'opencode', 'sessionID'],
			['codex/sessions.json', 'codex', 'threadId'],
			['cc/sessions.json', 'cc', 'sessionId'],
		] as const) {
			for (const [key, raw] of Object.entries(maps.get(rel) ?? {})) {
				const bound = parseBindingKey(key);
				if (!bound || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`invalid legacy session: ${rel}`);
				const state = raw as Record<string, unknown>;
				if (!validId(state[field]) || (provider === 'opencode' && !validId(state.directory))) throw new Error(`invalid legacy session payload: ${rel}`);
				// CC's bind token and native session_id coexist; only the token is a CLI alias.
				if (provider === 'cc') {
					const ccId = aliasKey({ provider, id: state.sessionId as string });
					if (seenNative.has(ccId)) throw new Error('duplicate legacy CC session');
					seenNative.add(ccId);
					if (this.options.activeUids.has(bound.aiclawUid)) {
						this.assertProvider(provider, bound.aiclawUid);
						const record = get(bound.aiclawUid, bound.roomId);
						record.nativeState.cc = copy(state);
					} // Inactive CC history is not a capability alias.
					continue;
				}
				attach(provider, bound.aiclawUid, bound.roomId, state[field], copy(state));
			}
		}
		const snapshot: Snapshot = { version: 1, sources, records };
		this.validate(snapshot);
		// Backup bytes before committing the marker+snapshot. Orphan backups after failed commit are safe.
		if (Object.keys(sources).length) {
			const dir = join(this.options.home, 'conversation-backups');
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			for (const [rel, hash] of Object.entries(sources)) {
				const backup = join(dir, `${rel.replaceAll('/', '-')}.bak`);
				if (!existsSync(backup)) writeFileSync(backup, readFileSync(join(this.options.home, rel)), { flag: 'wx', mode: 0o600 });
				if (digest(readFileSync(backup)) !== hash) throw new Error(`migration backup conflict: ${rel}`);
				if (process.platform !== 'win32') chmodSync(backup, 0o600);
			}
		}
		this.verifySources(sources);
		return snapshot;
	}
}
