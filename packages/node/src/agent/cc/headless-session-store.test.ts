import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileCcHeadlessSessionStore } from './headless-session-store.js';

const tmpDirs: string[] = [];
function freshPath(): string {
	const d = mkdtempSync(join(tmpdir(), 'cc-headless-store-'));
	tmpDirs.push(d);
	return join(d, 'sessions.json');
}

afterEach(() => {
	for (const d of tmpDirs.splice(0)) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}
});

describe('FileCcHeadlessSessionStore', () => {
	it('set → get round-trips a sessionId under the (uid,room) key', () => {
		const store = new FileCcHeadlessSessionStore(freshPath());
		store.set('aiclaw-5-room-9', { sessionId: 'sid-abc' });
		expect(store.get('aiclaw-5-room-9')).toEqual({ sessionId: 'sid-abc' });
		expect(store.get('aiclaw-5-room-999')).toBeUndefined();
	});

	it('persists to disk and reloads across instances', () => {
		const path = freshPath();
		new FileCcHeadlessSessionStore(path).set('aiclaw-1-room-2', { sessionId: 'sid-1' });
		expect(existsSync(path)).toBe(true);
		const reopened = new FileCcHeadlessSessionStore(path);
		expect(reopened.get('aiclaw-1-room-2')?.sessionId).toBe('sid-1');
	});

	it('delete removes the binding', () => {
		const store = new FileCcHeadlessSessionStore(freshPath());
		store.set('aiclaw-1-room-2', { sessionId: 'sid-1' });
		store.delete('aiclaw-1-room-2');
		expect(store.get('aiclaw-1-room-2')).toBeUndefined();
	});

	it('a corrupt file degrades to an empty store (no throw)', () => {
		const path = freshPath();
		writeFileSync(path, '{ this is not json', 'utf-8');
		const store = new FileCcHeadlessSessionStore(path);
		expect(store.get('anything')).toBeUndefined();
		// still usable after the corrupt load
		store.set('aiclaw-1-room-1', { sessionId: 'sid-x' });
		expect(store.get('aiclaw-1-room-1')?.sessionId).toBe('sid-x');
	});

	it('set overwrites an existing sessionId (rebind on a fresh turn)', () => {
		const path = freshPath();
		const store = new FileCcHeadlessSessionStore(path);
		store.set('aiclaw-1-room-1', { sessionId: 'sid-old' });
		store.set('aiclaw-1-room-1', { sessionId: 'sid-new' });
		expect(store.get('aiclaw-1-room-1')?.sessionId).toBe('sid-new');
		// on-disk reflects the new id
		expect(JSON.parse(readFileSync(path, 'utf-8'))['aiclaw-1-room-1'].sessionId).toBe('sid-new');
	});
});
