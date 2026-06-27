import { describe, it, expect } from 'vitest';
import { FileCodexSessionStore } from './session-store.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

/** A fresh file-backed store under a throwaway temp dir (no shared on-disk state). */
function freshStore(): FileCodexSessionStore {
	const dir = mkdtempSync(join(tmpdir(), 'aichat-codex-sess-'));
	return new FileCodexSessionStore(join(dir, 'sessions.json'));
}

describe('FileCodexSessionStore', () => {
	it('get/set round-trips a threadId binding', () => {
		const store = freshStore();
		store.set('aiclaw-5-room-9', { threadId: 'thread_aaa' });
		expect(store.get('aiclaw-5-room-9')).toEqual({ threadId: 'thread_aaa' });
	});

	it('findKeyByThreadId returns the key whose stored threadId matches', () => {
		const store = freshStore();
		store.set('aiclaw-5-room-9', { threadId: 'thread_aaa' });
		store.set('aiclaw-7-room-3', { threadId: 'thread_bbb' });
		expect(store.findKeyByThreadId('thread_aaa')).toBe('aiclaw-5-room-9');
		expect(store.findKeyByThreadId('thread_bbb')).toBe('aiclaw-7-room-3');
	});

	it('findKeyByThreadId → undefined for an unknown / empty store', () => {
		const store = freshStore();
		expect(store.findKeyByThreadId('thread_x')).toBeUndefined();
		store.set('aiclaw-5-room-9', { threadId: 'thread_aaa' });
		expect(store.findKeyByThreadId('thread_nope')).toBeUndefined();
	});

	it('delete removes the binding', () => {
		const store = freshStore();
		store.set('aiclaw-5-room-9', { threadId: 'thread_aaa' });
		store.delete('aiclaw-5-room-9');
		expect(store.get('aiclaw-5-room-9')).toBeUndefined();
		expect(store.findKeyByThreadId('thread_aaa')).toBeUndefined();
	});

	it('persists across instances on the same path', () => {
		const dir = mkdtempSync(join(tmpdir(), 'aichat-codex-sess-'));
		const path = join(dir, 'sessions.json');
		new FileCodexSessionStore(path).set('aiclaw-1-room-2', { threadId: 'thread_persist' });
		const reloaded = new FileCodexSessionStore(path);
		expect(reloaded.get('aiclaw-1-room-2')).toEqual({ threadId: 'thread_persist' });
		expect(reloaded.findKeyByThreadId('thread_persist')).toBe('aiclaw-1-room-2');
	});
});
