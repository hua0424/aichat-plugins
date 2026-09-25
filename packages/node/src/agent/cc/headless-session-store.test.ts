import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileCcHeadlessSessionStore } from './headless-session-store.js';

const tmpDirs: string[] = [];
const stores: FileCcHeadlessSessionStore[] = [];
function trackedStore(path: string): FileCcHeadlessSessionStore {
	const store = new FileCcHeadlessSessionStore(path);
	stores.push(store);
	return store;
}
function freshPath(): string {
	const d = mkdtempSync(join(tmpdir(), 'cc-headless-store-'));
	tmpDirs.push(d);
	return join(d, 'sessions.json');
}

afterEach(async () => {
	await Promise.all(stores.splice(0).map((store) => store.whenPersisted()));
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
		const store = trackedStore(freshPath());
		store.set('aiclaw-5-room-9', { sessionId: 'sid-abc' });
		expect(store.get('aiclaw-5-room-9')).toEqual({ sessionId: 'sid-abc' });
		expect(store.get('aiclaw-5-room-999')).toBeUndefined();
	});

	it('persists to disk and reloads across instances', async () => {
		const path = freshPath();
		const store = trackedStore(path);
		store.set('aiclaw-1-room-2', { sessionId: 'sid-1' });
		await store.whenPersisted(); // #166: persist is async now
		expect(existsSync(path)).toBe(true);
		const reopened = trackedStore(path);
		expect(reopened.get('aiclaw-1-room-2')?.sessionId).toBe('sid-1');
	});

	it('delete removes the binding', () => {
		const store = trackedStore(freshPath());
		store.set('aiclaw-1-room-2', { sessionId: 'sid-1' });
		store.delete('aiclaw-1-room-2');
		expect(store.get('aiclaw-1-room-2')).toBeUndefined();
	});

	it('a corrupt file fails closed without overwriting existing history', () => {
		const path = freshPath();
		writeFileSync(path, '{ this is not json', 'utf-8');
		expect(() => new FileCcHeadlessSessionStore(path)).toThrow();
		expect(readFileSync(path, 'utf-8')).toBe('{ this is not json');
	});

	it('set overwrites an existing sessionId (rebind on a fresh turn)', async () => {
		const path = freshPath();
		const store = trackedStore(path);
		store.set('aiclaw-1-room-1', { sessionId: 'sid-old' });
		store.set('aiclaw-1-room-1', { sessionId: 'sid-new' });
		expect(store.get('aiclaw-1-room-1')?.sessionId).toBe('sid-new');
		await store.whenPersisted(); // #166: persist is async now
		// on-disk reflects the new id
		expect(JSON.parse(readFileSync(path, 'utf-8'))['aiclaw-1-room-1'].sessionId).toBe('sid-new');
	});

	it('#166: setting the SAME sessionId is a skip-if-unchanged no-op (no rewrite)', async () => {
		const path = freshPath();
		const store = trackedStore(path);
		store.set('aiclaw-1-room-1', { sessionId: 'sid-x' });
		await store.whenPersisted();
		const mtime1 = statSync(path).mtimeMs;
		store.set('aiclaw-1-room-1', { sessionId: 'sid-x' }); // unchanged → no write queued
		await store.whenPersisted();
		expect(statSync(path).mtimeMs).toBe(mtime1); // file untouched
	});
});
