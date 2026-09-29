import { describe, it, expect } from 'vitest';
import { InMemoryBindTokenStore } from './bind-token-store.js';

/** A deterministic token generator: `tok-1`, `tok-2`, … so tests never depend on crypto randomness. */
function counterGen(): () => string {
	let n = 0;
	return () => `tok-${++n}`;
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
