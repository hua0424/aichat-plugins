import { describe, it, expect } from 'vitest';
import { FileSessionStore } from './session-store.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

/** A fresh file-backed store under a throwaway temp dir (no shared on-disk state). */
function freshStore(): FileSessionStore {
	const dir = mkdtempSync(join(tmpdir(), 'aichat-sess-'));
	return new FileSessionStore(join(dir, 'sessions.json'));
}

describe('FileSessionStore.findKeyBySessionID', () => {
	it('returns the key whose stored sessionID matches', () => {
		const store = freshStore();
		store.set('aiclaw-5-room-9', { sessionID: 'ses_aaa', directory: '/w/a' });
		store.set('aiclaw-7-room-3', { sessionID: 'ses_bbb', directory: '/w/b' });

		expect(store.findKeyBySessionID('ses_aaa')).toBe('aiclaw-5-room-9');
		expect(store.findKeyBySessionID('ses_bbb')).toBe('aiclaw-7-room-3');
	});

	it('returns undefined for an unknown sessionID', () => {
		const store = freshStore();
		store.set('aiclaw-5-room-9', { sessionID: 'ses_aaa', directory: '/w/a' });
		expect(store.findKeyBySessionID('ses_nope')).toBeUndefined();
	});

	it('returns undefined on an empty store', () => {
		expect(freshStore().findKeyBySessionID('ses_x')).toBeUndefined();
	});
});
