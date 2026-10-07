import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore, suspensionReason, type Provider } from './conversations.js';

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

	it('rejects another OpenCode conversation claiming the same physical directory across restart', () => {
		const root = home(), opts = active(root, { '1': 'opencode', '2': 'opencode' });
		const directory = join(root, 'workspace');
		mkdirSync(directory);
		const store = new ConversationStore(opts);
		const one = store.registerNative('opencode', 'session-1', '1', '9', { sessionID: 'session-1', directory });
		const aliasPath = join(root, 'workspace', '..', 'workspace');
		const reopened = new ConversationStore(opts);
		expect(() => reopened.assertOpencodeDirectoryOwner(one.conversationId, aliasPath)).not.toThrow();
		expect(() => reopened.assertOpencodeDirectoryOwner(reopened.getOrCreate('2', '9').conversationId, aliasPath))
			.toThrow('PROMPT_SCOPE_CONFLICT');
		expect(() => reopened.registerNative('opencode', 'session-2', '2', '9', { sessionID: 'session-2', directory: aliasPath }))
			.toThrow('PROMPT_SCOPE_CONFLICT');
		expect(reopened.resolveLegacy('opencode:session-2')).toBeUndefined();
		const pending = reopened.beginRun('1', '9', 'old-run');
		pending.saveRecovery({ version: 1, value: { provider: 'opencode', directory, sessionID: 'session-1' } });
		reopened.reset('1', '9'); // Clears nativeState, but does not prove old task stopped.
		const afterReset = new ConversationStore(opts);
		expect(afterReset.get('1', '9')?.nativeState.opencode).toBeUndefined();
		expect(() => afterReset.assertOpencodeDirectoryOwner(afterReset.get('2', '9')!.conversationId, aliasPath))
			.toThrow('PROMPT_SCOPE_CONFLICT');
	});

	it('retains OpenClaw global prompt ownership across restart and reset with unconfirmed old work', () => {
		const root = home(), opts = active(root, { '1': 'openclaw', '2': 'openclaw' });
		const store = new ConversationStore(opts);
		const first = store.registerNative('openclaw', token, '1', '9', { token, nativeRef: `${token}:aiclaw-1-room-9` });
		const sameIdentity = store.getOrCreate('1', '10');
		const other = store.getOrCreate('2', '9');
		const reopened = new ConversationStore(opts);
		expect(() => reopened.assertOpenclawPromptOwner(sameIdentity.conversationId, '1')).not.toThrow();
		expect(() => reopened.assertOpenclawPromptOwner(other.conversationId, '2')).toThrow('PROMPT_SCOPE_CONFLICT');
		const pending = reopened.beginRun('1', '9', 'old-openclaw');
		pending.saveRecovery({ version: 1, value: { provider: 'openclaw', nativeRef: `${token}:aiclaw-1-room-9` } });
		reopened.reset('1', '9');
		const afterReset = new ConversationStore(opts);
		expect(afterReset.get('1', '9')?.nativeState.openclaw).toBeUndefined();
		expect(() => afterReset.assertOpenclawPromptOwner(sameIdentity.conversationId, '1')).toThrow('PROMPT_SCOPE_CONFLICT');
		expect(() => afterReset.assertOpenclawPromptOwner(first.conversationId, '2')).toThrow('invalid OpenClaw prompt owner');
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
		expect(store.getNative('cc', '44', '888')).toEqual({ sessionId: 'cc-44', cwdConfirmationRequired: true });
		expect(store.get('44', '888')?.state).toBe('suspended');
		expect(suspensionReason(store.get('44', '888'))).toBe('cc-original-cwd-unconfirmed'); // #343 可核验恢复
		expect(() => store.mintToken('44', '888')).toThrow('paused');
		store.confirmCcOriginalCwd('44', '888', 'cc-44', 1, '/original', 'https://example.test/owner-approval', 'f'.repeat(64));
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

	it('durably gates legacy CC snapshots, confirms only exact original cwd with audit, and reset opens fresh', () => {
		let fail = false;
		const root = home(), opts = active(root, { '44': 'cc' }, () => { if (fail) throw new Error('disk full'); });
		legacy(root, 'cc/sessions.json', { 'aiclaw-44-room-888': { sessionId: 'cc-44' } });
		const store = new ConversationStore(opts);
		const old = store.get('44', '888')!;
		expect(old.state).toBe('suspended');
		expect(() => store.beginRun('44', '888', 'run')).toThrow('paused');
		expect(() => store.confirmCcOriginalCwd('44', 'other', 'cc-44', 1, '/original', 'https://example.test/approval', 'a'.repeat(64))).toThrow('target changed');
		expect(() => store.confirmCcOriginalCwd('44', '888', 'wrong', 1, '/original', 'https://example.test/approval', 'a'.repeat(64))).toThrow('target changed');
		fail = true;
		expect(() => store.confirmCcOriginalCwd('44', '888', 'cc-44', 1, '/original', 'https://example.test/approval', 'a'.repeat(64))).toThrow('disk full');
		expect(store.get('44', '888')).toEqual(old);
		fail = false;
		const approved = store.confirmCcOriginalCwd('44', '888', 'cc-44', 1, '/original', 'https://example.test/approval', 'a'.repeat(64));
		expect(approved).toMatchObject({ state: 'ready', ccCwdConfirmation: { cwd: '/original', sessionId: 'cc-44', approvalSha256: 'a'.repeat(64) } });
		expect(store.confirmCcOriginalCwd('44', '888', 'cc-44', 1, '/original', 'https://example.test/approval', 'a'.repeat(64))).toEqual(approved);
		expect(() => store.confirmCcOriginalCwd('44', '888', 'cc-44', 1, '/different', 'https://example.test/approval', 'a'.repeat(64))).toThrow('conflicting');
		const run = store.beginRun('44', '888', 'run');
		run.saveNativeState('cc', { sessionId: 'cc-44', workspace: '/original' });
		expect(store.get('44', '888')?.ccCwdConfirmation).toEqual(approved.ccCwdConfirmation);
		store.finishRun('run');
		expect(new ConversationStore(active(root, { '44': 'cc' })).get('44', '888')?.ccCwdConfirmation).toEqual(approved.ccCwdConfirmation);
		const snapshotPath = join(root, 'conversations.json'), trustedBytes = readFileSync(snapshotPath, 'utf8');
		for (const tamper of [
			(state: Record<string, unknown>) => { state.workspace = '/other'; },
			(state: Record<string, unknown>) => { state.cwdConfirmationRequired = true; },
		]) {
			const corrupted = JSON.parse(trustedBytes);
			tamper(corrupted.records[0].nativeState.cc);
			const corruptedBytes = JSON.stringify(corrupted);
			writeFileSync(snapshotPath, corruptedBytes);
			expect(() => new ConversationStore(active(root, { '44': 'cc' }))).toThrow('confirmed original cwd conflicts');
			expect(readFileSync(snapshotPath, 'utf8')).toBe(corruptedBytes); // fail closed, do not rewrite history
		}
		writeFileSync(snapshotPath, trustedBytes);
		const fresh = store.reset('44', '888');
		expect(fresh).toMatchObject({ state: 'ready', nativeState: {}, generation: 2 });
		expect(fresh.ccCwdConfirmation).toEqual(approved.ccCwdConfirmation);
		store.beginRun('44', '888', 'fresh');
	});

	it('upgrades a preexisting ready snapshot with missing CC cwd to persisted suspended gate (#343 field shape)', () => {
		const root = home(), opts = active(root, { '44': 'cc' });
		// #343 现场：前门控迁移把 sessionId 落盘却从未保存原 cwd，state 仍为 ready；重开必须升级为挂起。
		const snapshot = join(root, 'conversations.json');
		writeFileSync(snapshot, JSON.stringify({ version: 1, sources: {}, records: [{
			conversationId: 'c3430000-0000-4000-8000-000000000001', serverNamespace: opts.serverNamespace,
			identityId: '44', roomId: '888', adapterInstanceId: 'cc', generation: 1,
			contextKey: 'a'.repeat(64), state: 'ready', nativeAliases: [{ provider: 'cc', id: 'cc-44' }],
			nativeState: { cc: { sessionId: 'cc-44' } },
		}] }));
		const reopened = new ConversationStore(opts);
		expect(reopened.get('44', '888')?.state).toBe('suspended');
		expect(suspensionReason(reopened.get('44', '888'))).toBe('cc-original-cwd-missing'); // #343 证据不足
		expect(JSON.parse(readFileSync(snapshot, 'utf8')).records[0].state).toBe('suspended');
		expect(reopened.reset('44', '888')).toMatchObject({ state: 'ready', nativeState: {}, generation: 2 });
	});

	it('#343: runtime CC writes must persist the original absolute cwd; pause states stay explainable', () => {
		const root = home(), opts = active(root, { '44': 'cc' });
		const store = new ConversationStore(opts);
		expect(suspensionReason(store.get('44', '888'))).toBeUndefined();
		// 写边界：可续会话不允许再落成「只有 sessionId」的不可恢复形状（本票诊断的事故根因）。
		expect(() => store.registerNative('cc', 'cc-44', '44', '888', { sessionId: 'cc-44' })).toThrow('absolute original workspace');
		expect(() => store.registerNative('cc', 'cc-44', '44', '888', { sessionId: 'cc-44', workspace: 'relative/x' })).toThrow('absolute original workspace');
		const record = store.registerNative('cc', 'cc-44', '44', '888', { sessionId: 'cc-44', workspace: '/original' });
		expect(record.state).toBe('ready');
		expect(suspensionReason(record)).toBeUndefined();
		const run = store.beginRun('44', '888', 'run-343');
		expect(suspensionReason(store.get('44', '888'))).toBe('occupied');
		expect(() => run.saveNativeState('cc', { sessionId: 'cc-44' })).toThrow('absolute original workspace');
		expect(() => run.saveNativeState('cc', { sessionId: 'cc-44', workspace: '/original', cwdConfirmationRequired: true })).toThrow('absolute original workspace');
		run.saveNativeState('cc', { sessionId: 'cc-44', workspace: '/moved' });
		expect(store.getNative('cc', '44', '888')).toEqual({ sessionId: 'cc-44', workspace: '/moved' });
		store.markStopUnconfirmed('run-343');
		expect(suspensionReason(store.get('44', '888'))).toBe('stop-unconfirmed');
		store.confirmStopped('run-343');
		expect(store.get('44', '888')?.state).toBe('ready');
	});

	it('confirms only frozen legacy Codex provenance atomically; survives restart and rejects agent overrides', () => {
		let fail = false;
		const root = home(), opts = active(root, { '22': 'codex' }, () => { if (fail) throw new Error('disk full'); });
		legacy(root, 'codex/sessions.json', { 'aiclaw-22-room-888': { threadId: 'old-thread' } });
		const store = new ConversationStore(opts);
		const before = store.get('22', '888')!;
		expect(before.state).toBe('suspended');
		expect(() => store.beginRun('22', '888', 'pending')).toThrow('paused');
		const confirm = (room = '888', thread = 'old-thread', generation = 1, cwd = join(root, 'original'), prompt = 'frozen prompt', ref = 'https://example.test/owner', artifact = 'a'.repeat(64)) =>
			store.confirmCodexOriginalThread('22', room, thread, generation, cwd, prompt, ref, artifact);
		expect(() => confirm('wrong')).toThrow('target changed');
		expect(() => confirm('888', 'wrong')).toThrow('target changed');
		expect(() => confirm('888', 'old-thread', 2)).toThrow('target changed');
		fail = true;
		expect(() => confirm()).toThrow('disk full');
		expect(store.get('22', '888')).toEqual(before);
		expect(new ConversationStore(active(root, { '22': 'codex' })).get('22', '888')).toEqual(before);
		fail = false;
		const approved = confirm();
		expect(approved).toMatchObject({ state: 'ready', nativeState: { codex: { threadId: 'old-thread', workspace: join(root, 'original'), originalPrompt: 'frozen prompt',
			promptHash: createHash('sha256').update('frozen prompt').digest('hex'), legacyConfirmationRequired: false } },
			codexThreadConfirmation: { threadId: 'old-thread', artifactSha256: 'a'.repeat(64) } });
		expect(confirm()).toEqual(approved);
		expect(() => confirm('888', 'old-thread', 1, join(root, 'other'))).toThrow('conflicting');
		const snapshotPath = join(root, 'conversations.json'), trusted = readFileSync(snapshotPath, 'utf8');
		const corrupted = JSON.parse(trusted);
		corrupted.records[0].nativeState.codex.originalPrompt = 'other prompt';
		writeFileSync(snapshotPath, JSON.stringify(corrupted));
		expect(() => new ConversationStore(active(root, { '22': 'codex' }))).toThrow('confirmed original prompt conflicts');
		writeFileSync(snapshotPath, trusted);
		const bound = store.beginRun('22', '888', 'run');
		expect(() => confirm()).toThrow('pending run');
		expect(() => bound.saveNativeState('codex', { threadId: 'old-thread', workspace: join(root, 'original'), promptHash: approved.nativeState.codex!.promptHash })).toThrow('provenance');
		expect(() => bound.registerNative('codex', 'different', { threadId: 'different' })).toThrow('alias');
		store.finishRun('run');
		expect(() => store.deleteNative('codex', '22', '888')).toThrow('reset');
		const restarted = new ConversationStore(active(root, { '22': 'codex' }));
		expect(restarted.get('22', '888')).toEqual({ ...approved, pendingRuns: [] });
		expect(restarted.resolveLegacy('codex:old-thread')?.conversationId).toBe(approved.conversationId);
		expect(readFileSync(join(root, 'conversation-backups', 'codex-sessions.json.bak'), 'utf8')).toBe(readFileSync(join(root, 'codex', 'sessions.json'), 'utf8'));
		expect(restarted.reset('22', '888')).toMatchObject({ state: 'ready', generation: 2, nativeState: {} });
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

	it('atomically resets generation and revokes old keys and native aliases across restart', () => {
		const root = home(), opts = active(root, { '11': 'codex' });
		const store = new ConversationStore(opts);
		const first = store.registerNative('codex', 'old-thread', '11', '9', { threadId: 'old-thread' });
		const next = store.reset('11', '9');
		expect(next).toMatchObject({ conversationId: first.conversationId, generation: 2, state: 'ready', nativeAliases: [], nativeState: {} });
		expect(next.contextKey).not.toBe(first.contextKey);
		expect(store.resolveCandidate({ key: first.contextKey })).toBeUndefined();
		expect(store.resolveLegacy('codex:old-thread')).toBeUndefined();
		expect(() => store.registerNative('codex', 'old-thread', '11', '9')).toThrow('revoked');
		const loaded = new ConversationStore(opts);
		expect(loaded.get('11', '9')).toEqual(next);
		expect(loaded.resolveCandidate({ key: first.contextKey })).toBeUndefined();
		expect(loaded.reset('11', '9').generation).toBe(3);
		const raw = JSON.parse(readFileSync(join(root, 'conversations.json'), 'utf8'));
		expect(raw.version).toBe(1);
	});

	it('persists only minimal bearer-bound reset receipts atomically with key revocation', () => {
		let fail = false;
		const root = home(), opts = active(root, { '11': 'codex' }, () => { if (fail) throw new Error('disk full'); });
		const store = new ConversationStore(opts);
		const first = store.getOrCreate('11', '9');
		const bearer = JSON.stringify([{ key: first.contextKey }]);
		fail = true;
		expect(() => store.reset('11', '9', 'request-1', bearer)).toThrow('disk full');
		expect(store.getResetReceipt(bearer, 'request-1')).toBeUndefined();
		expect(store.get('11', '9')).toEqual(first);
		fail = false;
		const next = store.reset('11', '9', 'request-1', bearer);
		expect(store.getResetReceipt(bearer, 'request-1')).toEqual({ reset: true, generation: 2, executionPaused: false });
		expect(store.getResetReceipt(JSON.stringify([{ key: next.contextKey }]), 'request-1')).toBeUndefined();
		expect(store.getResetReceipt(bearer, 'other-request')).toBeUndefined();
		expect(() => store.reset('11', '9', 'request-1', bearer)).toThrow('duplicate reset requestId');
		expect(new ConversationStore(active(root, { '11': 'codex' })).getResetReceipt(bearer, 'request-1')?.generation).toBe(2);
		const persisted = readFileSync(join(root, 'conversations.json'), 'utf8');
		expect(persisted).not.toContain('request-1');
		expect(persisted).not.toContain(bearer);
	});

	it('binds native writes to a generation and retains old run recovery through repeated resets', () => {
		const root = home(), opts = active(root, { '11': 'codex' });
		const store = new ConversationStore(opts);
		const bound = store.beginRun('11', '9', 'run-1');
		bound.saveNativeState('codex', { threadId: 'thread-1' });
		bound.registerNativeAlias('codex', 'thread-1');
		bound.saveRecovery({ version: 1, value: { processId: 123 } });
		expect(() => store.beginRun('11', '9', 'run-2')).toThrow('occupied');
		store.markCancelling('run-1');
		expect(store.get('11', '9')?.state).toBe('suspended');
		expect(() => bound.saveNativeState('codex', { threadId: 'late' })).toThrow('paused');
		store.reset('11', '9');
		store.reset('11', '9');
		expect(store.get('11', '9')).toMatchObject({ generation: 3, state: 'stop_unconfirmed', nativeState: {} });
		expect(store.pendingRuns()[0]).toMatchObject({ runId: 'run-1', generation: 1, recovery: { version: 1, value: { processId: 123 } } });
		expect(() => bound.saveNativeState('codex', { threadId: 'late' })).toThrow('STALE_GENERATION');
		expect(() => bound.registerNativeAlias('codex', 'late')).toThrow('STALE_GENERATION');
		expect(() => store.registerNative('codex', 'late', '11', '9', { threadId: 'late' })).toThrow('paused');
		expect(() => store.deleteNative('codex', '11', '9')).toThrow('paused');
		bound.saveRecovery({ version: 2, value: { processId: 123, diagnostic: 'alive' } });
		const restarted = new ConversationStore(opts);
		expect(restarted.pendingRuns()[0].recovery?.version).toBe(2);
		expect(() => restarted.beginRun('11', '9', 'run-2')).toThrow('paused');
		restarted.confirmStopped('run-1');
		expect(restarted.get('11', '9')?.state).toBe('ready');
		expect(restarted.beginRun('11', '9', 'run-2').generation).toBe(3);
	});

	it('rolls back reset, bound writes and recovery atomically on persistence failure', () => {
		let fail = false;
		const root = home(), opts = active(root, { '11': 'codex' }, () => { if (fail) throw new Error('disk full'); });
		const store = new ConversationStore(opts);
		const bound = store.beginRun('11', '9', 'run-1');
		const previous = store.get('11', '9');
		fail = true;
		expect(() => store.reset('11', '9')).toThrow('disk full');
		expect(() => bound.saveNativeState('codex', { threadId: 'thread' })).toThrow('disk full');
		expect(() => bound.saveRecovery({ version: 1, value: 'recover' })).toThrow('disk full');
		expect(() => store.markStopUnconfirmed('run-1')).toThrow('disk full');
		expect(store.get('11', '9')).toEqual(previous);
		expect(() => store.reset('11', 'new-room')).toThrow('disk full');
		expect(store.get('11', 'new-room')).toBeUndefined();
		expect(store.pendingRuns()[0].recovery).toBeUndefined();
		expect(new ConversationStore(active(root, { '11': 'codex' })).get('11', '9')?.state).toBe('stop_unconfirmed');
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
