import { AsyncLocalStorage } from 'node:async_hooks';
import { bindingKey, parseBindingKey, type BindTokenStore } from '../agent/bind-token-store.js';
import type { SessionStore, StoredSession } from '../agent/opencode/session-store.js';
import type { CodexSessionStore, StoredCodexSession } from '../agent/codex/session-store.js';
import type { CcHeadlessSessionStore, StoredCcHeadlessSession } from '../agent/cc/headless-session-store.js';
import type { ConversationStore, Provider } from './conversations.js';

export interface LegacyNativeScope {
	identityId: string;
	roomId: string;
	conversationId: string;
	generation: number;
}

const nativeScope = new AsyncLocalStorage<LegacyNativeScope>();

/** Bind driver-created async tasks without changing unrelated CLI capability requests. */
export function withLegacyNativeScope<T>(scope: LegacyNativeScope, fn: () => T): T {
	return nativeScope.run(scope, fn);
}

/** Old drivers keep their native execution APIs; every binding read/write goes through one core owner. */
export function legacyBridges(store: () => ConversationStore): {
	bindTokens: BindTokenStore;
	opencode: SessionStore;
	codex: CodexSessionStore;
	cc: CcHeadlessSessionStore;
} {
	const assertCurrent = (uid: string, room: string): void => {
		const scope = nativeScope.getStore();
		if (!scope) return; // CLI capabilities are not native driver callbacks.
		const current = store().get(uid, room);
		if (scope.identityId !== uid || scope.roomId !== room ||
			current?.conversationId !== scope.conversationId || current.generation !== scope.generation)
			throw new Error('STALE_GENERATION');
	};
	const native = <T extends object>(provider: Provider) => ({
		get(key: string): T | undefined {
			const b = parseBindingKey(key);
			if (b) assertCurrent(b.aiclawUid, b.roomId);
			return b ? store().getNative(provider, b.aiclawUid, b.roomId) as T | undefined : undefined;
		},
		set(key: string, value: T, id: string): void {
			const b = parseBindingKey(key);
			if (!b) throw new Error('invalid native binding key');
			assertCurrent(b.aiclawUid, b.roomId);
			store().registerNative(provider, id, b.aiclawUid, b.roomId, value as Record<string, unknown>);
		},
		delete(key: string): void {
			const b = parseBindingKey(key);
			if (!b) throw new Error('invalid native binding key');
			assertCurrent(b.aiclawUid, b.roomId);
			store().deleteNative(provider, b.aiclawUid, b.roomId);
		},
		findKey(id: string): string | undefined {
			const r = store().findNative(provider, id);
			if (r) assertCurrent(r.identityId, r.roomId);
			return r ? bindingKey(r.identityId, r.roomId) : undefined;
		},
	});
	const oc = native<StoredSession>('opencode');
	const codex = native<StoredCodexSession>('codex');
	const cc = native<StoredCcHeadlessSession>('cc');
	return {
		bindTokens: {
			mint: (uid, room) => { assertCurrent(uid, room); return store().mintToken(uid, room); },
			resolve: (token) => {
				const openclaw = store().resolveToken('openclaw', token);
				const claude = store().resolveToken('cc', token);
				if (openclaw && claude) return undefined;
				const r = openclaw ?? claude;
				return r ? { aiclawUid: r.identityId, roomId: r.roomId } : undefined;
			},
		},
		opencode: {
			get: oc.get, set: (key, v) => oc.set(key, v, v.sessionID), delete: oc.delete,
			findKeyBySessionID: oc.findKey,
		},
		codex: {
			get: codex.get, set: (key, v) => codex.set(key, v, v.threadId), delete: codex.delete,
			findKeyByThreadId: codex.findKey,
		},
		cc: {
			get: cc.get, set: (key, v) => cc.set(key, v, v.sessionId), delete: cc.delete,
		},
	};
}
