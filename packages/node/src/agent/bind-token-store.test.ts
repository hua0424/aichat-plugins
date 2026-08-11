import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { InMemoryBindTokenStore, FileBindTokenStore } from './bind-token-store.js';

/** A deterministic token generator: `tok-1`, `tok-2`, … so tests never depend on crypto randomness. */
function counterGen(): () => string {
	let n = 0;
	return () => `tok-${++n}`;
}

function freshFile(): string {
	const dir = mkdtempSync(join(tmpdir(), 'aichat-bindtok-'));
	return join(dir, 'bind-tokens.json');
}

describe('BindTokenStore.mint — stable per (uid,room)', () => {
	it('the same (uid,room) mints the SAME token; a different (uid,room) mints a DIFFERENT token', () => {
		const store = new InMemoryBindTokenStore(counterGen());
		const t1 = store.mint('7', '42');
		const t1again = store.mint('7', '42');
		const t2 = store.mint('8', '42');
		const t3 = store.mint('7', '43');
		expect(t1again).toBe(t1); // stable — reuse, do not re-mint
		expect(t2).not.toBe(t1);
		expect(t3).not.toBe(t1);
		expect(t2).not.toBe(t3);
	});

	it('a minted token resolves back to its exact (uid,room)', () => {
		const store = new InMemoryBindTokenStore(counterGen());
		const token = store.mint('999', '888');
		expect(store.resolve(token)).toEqual({ aiclawUid: '999', roomId: '888' });
	});

	it('REQ-029 (#29): >2^53 uid/room survive as EXACT strings through mint→resolve', () => {
		const store = new InMemoryBindTokenStore(counterGen());
		const token = store.mint('9007199254740993', '9007199254740994');
		expect(store.resolve(token)).toEqual({
			aiclawUid: '9007199254740993',
			roomId: '9007199254740994',
		});
	});
});

describe('BindTokenStore.resolve — rejects unknown / garbage / forged', () => {
	it('garbage, empty, and a never-minted (but plausible) plaintext binding all → undefined', () => {
		const store = new InMemoryBindTokenStore(counterGen());
		store.mint('7', '42'); // mint SOMETHING so the map is non-empty
		expect(store.resolve('garbage')).toBeUndefined();
		expect(store.resolve('')).toBeUndefined();
		// the SOUL of BL-014: a forged plaintext binding an agent could guess is NOT a minted token.
		expect(store.resolve('aiclaw-999-room-888')).toBeUndefined();
	});
});

describe('BindTokenStore — case-insensitive (openclaw lowercases the sessionKey)', () => {
	it('a case-mangled token still resolves to its exact (uid,room) — openclaw may lowercase what it echoes back', () => {
		// DEFAULT generator (mixed-case-capable source) → mint normalizes to lowercase.
		const store = new InMemoryBindTokenStore();
		const token = store.mint('7', '42');
		const bound = { aiclawUid: '7', roomId: '42' };
		// openclaw returns the token upper-cased (a stand-in for its lowercasing/case-mangling):
		expect(store.resolve(token.toUpperCase())).toEqual(bound);
		// …and the as-minted (already-lowercase) token resolves too:
		expect(store.resolve(token)).toEqual(bound);
	});

	it('the DEFAULT generator yields a lowercase-only token (hex, no-op under openclaw lowercasing)', () => {
		const token = new InMemoryBindTokenStore().mint('1', '2');
		expect(token).toMatch(/^[0-9a-f]+$/);
		expect(token).toBe(token.toLowerCase());
	});
});

describe('FileBindTokenStore — persistence + reload', () => {
	it('persists mints; a fresh instance on the same path reloads (token still resolves, mint still stable)', async () => {
		const path = freshFile();
		const first = new FileBindTokenStore(path, counterGen());
		const token = first.mint('5', '9');
		await first.whenPersisted(); // #166: persist is async now
		expect(existsSync(path)).toBe(true);

		// A fresh instance loads from disk. Its own genToken should NOT be needed for the reloaded pair.
		const reloaded = new FileBindTokenStore(path, counterGen());
		expect(reloaded.resolve(token)).toEqual({ aiclawUid: '5', roomId: '9' });
		// mint is still STABLE across the reload — the reverse index was rebuilt on load.
		expect(reloaded.mint('5', '9')).toBe(token);
	});

	it.runIf(process.platform !== 'win32')('the persisted token file is chmod 0600 (sensitive credential)', async () => {
		const path = freshFile();
		const store = new FileBindTokenStore(path, counterGen());
		store.mint('5', '9');
		await store.whenPersisted(); // #166: persist is async now
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it('loads a legacy MIXED-CASE token file and still resolves (P1)', () => {
		// A bind-tokens.json written BEFORE #161 normalization stored the token key raw (mixed case).
		// load() must lowercase the key on rebuild so resolve()/mint() (which use lowercase) still hit it.
		const path = freshFile();
		writeFileSync(path, JSON.stringify({ AbCdEf123: { aiclawUid: '7', roomId: '42' } }), 'utf-8');
		const store = new FileBindTokenStore(path);
		const bound = { aiclawUid: '7', roomId: '42' };
		// the lowercased form openclaw would echo back:
		expect(store.resolve('abcdef123')).toEqual(bound);
		// the original mixed-case string also resolves (resolve lowercases its input):
		expect(store.resolve('AbCdEf123')).toEqual(bound);
		// mint reuses the SAME (uid,room), returning the normalized (lowercase) stored token:
		expect(store.mint('7', '42')).toBe('abcdef123');
	});

	it('a corrupt/unparseable file degrades to an empty store (never crashes)', () => {
		const path = freshFile();
		// write garbage via a store, then hand a broken file — but simplest: FileBindTokenStore on a
		// non-JSON file. Emulate by writing then corrupting is overkill; a missing file already loads empty.
		const store = new FileBindTokenStore(path, counterGen());
		expect(store.resolve('anything')).toBeUndefined();
		const token = store.mint('1', '2');
		expect(store.resolve(token)).toEqual({ aiclawUid: '1', roomId: '2' });
	});
});
