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
	state: 'ready';
	nativeAliases: NativeAlias[];
	/** Original provider store payloads. OpenClaw retains both the bare token and full gateway sessionKey. */
	nativeState: Partial<Record<Provider, Record<string, unknown>>>;
}
interface Snapshot { version: 1; sources: Record<string, string>; records: ConversationRecord[] }
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

	contextKey(identityId: string, roomId: string): string { return this.getOrCreate(identityId, roomId).contextKey; }

	registerNative(provider: Provider, id: string, identityId: string, roomId: string,
		nativeState?: Record<string, unknown>, runtimeScope?: string): ConversationRecord {
		this.assertProvider(provider, identityId);
		if (!validId(id) || (runtimeScope !== undefined && !validId(runtimeScope))) throw new Error('invalid native alias');
		const prior = this.get(identityId, roomId);
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
	private commit(records: ConversationRecord[]): void {
		if (this.closed) throw new Error('conversation store closed');
		const next: Snapshot = { ...this.snapshot, records };
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
		const ids = new Set<string>(), keys = new Set<string>(), pairs = new Set<string>(), aliases = new Set<string>(), ccSessions = new Set<string>();
		for (const r of data.records) {
			if (!r || r.serverNamespace !== this.options.serverNamespace || !validId(r.identityId) || !validId(r.roomId) ||
				!validId(r.conversationId) || !validId(r.adapterInstanceId) || !/^[0-9a-f]{64}$/.test(r.contextKey) ||
				r.generation !== 1 || r.state !== 'ready' || !Array.isArray(r.nativeAliases) ||
				!r.nativeState || typeof r.nativeState !== 'object' || Array.isArray(r.nativeState)) throw new Error('invalid conversation record');
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
