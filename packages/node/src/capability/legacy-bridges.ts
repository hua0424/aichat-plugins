import { bindingKey, parseBindingKey, type BindTokenStore } from '../agent/bind-token-store.js';
import type { SessionStore, StoredSession } from '../agent/opencode/session-store.js';
import type { CodexSessionStore, StoredCodexSession } from '../agent/codex/session-store.js';
import type { CcHeadlessSessionStore, StoredCcHeadlessSession } from '../agent/cc/headless-session-store.js';
import type { ConversationStore, Provider } from './conversations.js';

/** Old drivers keep their native execution APIs; every binding read/write goes through one core owner. */
export function legacyBridges(store: () => ConversationStore): {
	bindTokens: BindTokenStore;
	opencode: SessionStore;
	codex: CodexSessionStore;
	cc: CcHeadlessSessionStore;
} {
	const native = <T extends object>(provider: Provider) => ({
		get(key: string): T | undefined {
			const b = parseBindingKey(key);
			return b ? store().getNative(provider, b.aiclawUid, b.roomId) as T | undefined : undefined;
		},
		set(key: string, value: T, id: string): void {
			const b = parseBindingKey(key);
			if (!b) throw new Error('invalid native binding key');
			store().registerNative(provider, id, b.aiclawUid, b.roomId, value as Record<string, unknown>);
		},
		delete(key: string): void {
			const b = parseBindingKey(key);
			if (!b) throw new Error('invalid native binding key');
			store().deleteNative(provider, b.aiclawUid, b.roomId);
		},
		findKey(id: string): string | undefined {
			const r = store().findNative(provider, id);
			return r ? bindingKey(r.identityId, r.roomId) : undefined;
		},
	});
	const oc = native<StoredSession>('opencode');
	const codex = native<StoredCodexSession>('codex');
	const cc = native<StoredCcHeadlessSession>('cc');
	return {
		bindTokens: {
			mint: (uid, room) => store().mintToken(uid, room),
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
