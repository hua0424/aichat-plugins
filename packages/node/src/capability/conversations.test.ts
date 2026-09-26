import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore, type Provider } from './conversations.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const home = () => { const dir = mkdtempSync(join(tmpdir(), 'aichat-conversations-')); dirs.push(dir); return dir; };
const active = (root: string, ids: Record<string, Provider>, beforePersist?: () => void) => ({
	home: root, serverNamespace: 'http://example.test/api', activeUids: new Set(Object.keys(ids)),
	activeProviders: new Map(Object.entries(ids)), beforePersist,
});
const legacy = (root: string, file: string, data: unknown) => {
	const path = join(root, file);
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, JSON.stringify(data));
};
const token = 'a'.repeat(64);

// These checks exercise the persisted bytes, not merely a fake index.
describe('ConversationStore', () => {
	it('mints one stable opaque key per namespace+identity+room through reload; rejects unknown/conflicting candidates', () => {
		const root = home(), opts = active(root, { '111': 'codex', '222': 'codex' });
		const store = new ConversationStore(opts);
		const one = store.getOrCreate('111', '900'), two = store.getOrCreate('222', '900');
		expect(one.generation).toBe(1);
		expect(store.contextKey('111', '900')).toBe(one.contextKey);
		expect(store.resolveCandidates([{ key: one.contextKey }, { key: one.contextKey }])?.conversationId).toBe(one.conversationId);
		expect(store.resolveCandidates([{ key: one.contextKey }, { key: two.contextKey }])).toBeUndefined();
		expect(store.resolveCandidates([{ key: one.contextKey }, { key: '0'.repeat(64) }])).toBeUndefined();
		expect(() => store.getOrCreate('333', '900')).toThrow('not activated');
		expect(new ConversationStore(opts).getOrCreate('111', '900')).toEqual(one);
		const raw = JSON.parse(readFileSync(join(root, 'conversations.json'), 'utf8'));
		expect(raw.version).toBe(1);
		if (process.platform !== 'win32') expect(statSync(join(root, 'conversations.json')).mode & 0o777).toBe(0o600);
	});

	it('uses native aliases as the sole legacy authority, rejects duplicate or ambiguous aliases', () => {
		const store = new ConversationStore(active(home(), { '1': 'codex', '2': 'codex' }));
		const one = store.registerNative('codex', 'thread', '1', '9', { threadId: 'thread' });
		expect(store.getNative('codex', '1', '9')).toEqual({ threadId: 'thread' });
		expect(store.resolveLegacy('codex:thread')?.contextKey).toBe(one.contextKey);
		expect(store.resolveCandidates([{ key: one.contextKey }, { provider: 'codex', nativeId: 'thread' }])?.conversationId).toBe(one.conversationId);
		expect(() => store.registerNative('codex', 'thread', '2', '9')).toThrow('native alias conflict');
		store.registerNative('codex', 'other', '1', '9', { threadId: 'other' });
		expect(store.resolveLegacy('codex:other')?.conversationId).toBe(one.conversationId);
		expect(store.resolveLegacy('codex:thread')).toBeUndefined();
		store.deleteNative('codex', '1', '9');
		expect(store.resolveLegacy('codex:other')).toBeUndefined();
		expect(store.get('1', '9')?.contextKey).toBe(one.contextKey);
		store.registerNative('codex', 'thread', '2', '9');
		expect(store.resolveLegacy('codex:thread')?.identityId).toBe('2');
	});

	it('imports only activated histories with exact OpenClaw composite nativeRef and immutable legacy backup marker', () => {
		const root = home(), opts = active(root, { '11': 'openclaw', '22': 'codex', '33': 'opencode', '44': 'cc' });
		legacy(root, 'bind-tokens.json', { [token]: { aiclawUid: '11', roomId: '888' }, ['b'.repeat(64)]: { aiclawUid: '44', roomId: '888' }, ['c'.repeat(64)]: { aiclawUid: '55', roomId: '888' } });
		legacy(root, 'codex/sessions.json', { 'aiclaw-22-room-888': { threadId: 'thread-22' }, 'aiclaw-55-room-888': { threadId: 'inactive' } });
		legacy(root, 'opencode/sessions.json', { 'aiclaw-33-room-888': { sessionID: 'session-33', directory: '/tmp/project' } });
		legacy(root, 'cc/sessions.json', { 'aiclaw-44-room-888': { sessionId: 'cc-44' } });
		const store = new ConversationStore(opts);
		expect(store.resolveLegacy(`openclaw:${token}`)?.identityId).toBe('11');
		expect(store.resolveLegacy(`openclaw:${token}:aiclaw-11-room-888`)).toBeUndefined();
		expect(store.getNative('openclaw', '11', '888')).toEqual({ token, nativeRef: `${token}:aiclaw-11-room-888` });
		expect(store.getNative('cc', '44', '888')).toEqual({ sessionId: 'cc-44' });
		expect(store.mintToken('44', '888')).toBe('b'.repeat(64));
		expect(store.resolveToken('cc', 'b'.repeat(64))?.identityId).toBe('44');
		expect(store.resolveLegacy('cc:cc-44')).toBeUndefined();
		store.deleteNative('cc', '44', '888');
		expect(store.getNative('cc', '44', '888')).toBeUndefined();
		expect(store.mintToken('44', '888')).toBe('b'.repeat(64));
		expect(store.resolveLegacy(`cc:${'b'.repeat(64)}`)?.identityId).toBe('44');
		expect(store.resolveLegacy('codex:thread-22')?.identityId).toBe('22');
		expect(store.resolveLegacy('opencode:session-33')?.identityId).toBe('33');
		expect(store.resolveLegacy('codex:inactive')).toBeUndefined();
		expect(store.get('55', '888')).toBeUndefined();
		const key = store.contextKey('11', '888');
		expect(new ConversationStore(opts).contextKey('11', '888')).toBe(key);
		for (const source of ['bind-tokens.json', 'codex/sessions.json', 'opencode/sessions.json', 'cc/sessions.json']) {
			expect(readFileSync(join(root, 'conversation-backups', `${source.replaceAll('/', '-')}.bak`))).toEqual(readFileSync(join(root, source)));
		}
		legacy(root, 'codex/sessions.json', { 'aiclaw-22-room-888': { threadId: 'silently-mutated' } });
		expect(() => new ConversationStore(opts)).toThrow('legacy source changed');
	});

	it('fails closed on broken, duplicate and ambiguous legacy input without committing a marker', () => {
		const root = home();
		writeFileSync(join(root, 'bind-tokens.json'), '{broken');
		expect(() => new ConversationStore(active(root, { '11': 'openclaw' }))).toThrow();
		expect(() => readFileSync(join(root, 'conversations.json'))).toThrow();
		const other = home();
		legacy(other, 'codex/sessions.json', { 'aiclaw-11-room-1': { threadId: 'duplicate' }, 'aiclaw-22-room-2': { threadId: 'duplicate' } });
		expect(() => new ConversationStore(active(other, { '11': 'codex' }))).toThrow('duplicate legacy native alias');
		const ambiguous = home();
		legacy(ambiguous, 'bind-tokens.json', { [token]: { aiclawUid: '11', roomId: '9' } });
		expect(() => new ConversationStore(active(ambiguous, { '11': 'codex' }))).toThrow('ambiguous provider');
	});

	it('requires explicit scope for ambiguous native IDs and rejects corrupted persisted indexes', () => {
		const root = home(), opts = active(root, { '11': 'opencode', '22': 'opencode' });
		const store = new ConversationStore(opts);
		store.registerNative('opencode', 'shared', '11', '1', { sessionID: 'shared', directory: '/one' }, 'a');
		store.registerNative('opencode', 'shared', '22', '2', { sessionID: 'shared', directory: '/two' }, 'b');
		expect(store.resolveLegacy('opencode:shared')).toBeUndefined();
		expect(store.findNative('opencode', 'shared', 'b')?.identityId).toBe('22');
		const path = join(root, 'conversations.json');
		const contents = JSON.parse(readFileSync(path, 'utf8'));
		contents.records[1].contextKey = contents.records[0].contextKey;
		writeFileSync(path, JSON.stringify(contents));
		expect(() => new ConversationStore(opts)).toThrow('duplicate conversation binding');
	});

	it('imports a formerly inactive legacy identity only when it later activates, without replacing new state', () => {
		const root = home(), oldToken = 'e'.repeat(64);
		legacy(root, 'bind-tokens.json', { [oldToken]: { aiclawUid: '22', roomId: '9' } });
		const initial = new ConversationStore(active(root, { '11': 'openclaw' }));
		const newKey = initial.contextKey('11', '9');
		expect(initial.resolveLegacy(`openclaw:${oldToken}`)).toBeUndefined();
		const later = new ConversationStore(active(root, { '11': 'openclaw', '22': 'cc' }));
		expect(later.contextKey('11', '9')).toBe(newKey);
		expect(later.resolveLegacy(`cc:${oldToken}`)?.identityId).toBe('22');
		expect(new ConversationStore(active(root, { '11': 'openclaw', '22': 'cc' })).mintToken('22', '9')).toBe(oldToken);
	});

	it('does not route an old provider alias into a new activated provider sharing the same uid', () => {
		const root = home();
		const previous = new ConversationStore(active(root, { '11': 'codex' }));
		previous.registerNative('codex', 'old-thread', '11', '9', { threadId: 'old-thread' });
		const switched = new ConversationStore(active(root, { '11': 'cc' }));
		expect(switched.resolveLegacy('codex:old-thread')).toBeUndefined();
		expect(() => switched.mintToken('11', '9')).toThrow('provider changed');
	});

	it('rolls back new and updated bindings on failed disk commit before exposure', () => {
		let fail = false;
		const root = home(), opts = active(root, { '11': 'codex' }, () => { if (fail) throw new Error('disk full'); });
		const store = new ConversationStore(opts);
		const original = store.getOrCreate('11', '1');
		fail = true;
		expect(() => store.registerNative('codex', 'thread', '11', '1', { threadId: 'thread' })).toThrow('disk full');
		expect(() => store.getOrCreate('11', '2')).toThrow('disk full');
		expect(store.getNative('codex', '11', '1')).toBeUndefined();
		expect(store.resolveLegacy('codex:thread')).toBeUndefined();
		expect(store.get('11', '2')).toBeUndefined();
		expect(new ConversationStore(active(root, { '11': 'codex' })).get('11', '1')).toEqual(original);
		fail = false;
		store.close();
		expect(() => store.registerNative('codex', 'late', '11', '1', { threadId: 'late' })).toThrow('closed');
		expect(store.resolveLegacy('codex:late')).toBeUndefined();
	});
});
