import { describe, it, expect, vi } from 'vitest';
import { CapabilityEndpoint } from '../../capability/endpoint.js';
import { CapabilityRegistry, sendMessageCapability } from '../../capability/registry.js';
import { FileCodexSessionStore } from './session-store.js';
import { resolveBoundSession } from '../../capability/session-key.js';
import { parseBindingKey } from '../bind-token-store.js';
import type { BindableAgent } from '../../capability/session-key.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync } from 'node:fs';

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

	it('rejects a duplicate native thread without changing the original room', () => {
		const store = freshStore();
		store.set('aiclaw-5-room-9', { threadId: 'same' });
		expect(() => store.set('aiclaw-7-room-3', { threadId: 'same' })).toThrow('Duplicate native session id');
		expect(store.findKeyByThreadId('same')).toBe('aiclaw-5-room-9');
		expect(store.get('aiclaw-7-room-3')).toBeUndefined();
	});

	it('refuses ambiguous native aliases found during legacy file recovery', () => {
		const path = join(mkdtempSync(join(tmpdir(), 'aichat-codex-duplicate-')), 'sessions.json');
		writeFileSync(path, JSON.stringify({ a: { threadId: 'same' }, b: { threadId: 'same' } }));
		expect(() => new FileCodexSessionStore(path)).toThrow('Duplicate native session id');
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

	it('two identities and two rooms share one map, route each native thread and resume after restart', async () => {
		const path = join(mkdtempSync(join(tmpdir(), 'aichat-codex-shared-')), 'sessions.json');
		const store = new FileCodexSessionStore(path);
		store.set('aiclaw-1-room-10', { threadId: 'thread_1' });
		store.set('aiclaw-2-room-20', { threadId: 'thread_2' });
		store.set('aiclaw-1-room-30', { threadId: 'thread_3' });
		await store.whenPersisted();
		const resumed = new FileCodexSessionStore(path);
		const agents = ['1', '2'].map((uid) => ({
			uid,
			api: { uid, sendMessage: vi.fn(async () => ({ msgId: 'ack' })) },
			driver: { type: 'codex', resolveSession: (thread: string) => {
				const binding = resumed.findKeyByThreadId(thread);
				return binding ? parseBindingKey(binding) : undefined;
			} },
		})) as unknown as BindableAgent[];
		const registry = new CapabilityRegistry();
		registry.register('send-message', sendMessageCapability());
		const endpoint = new CapabilityEndpoint({ registry, resolve: (key) => resolveBoundSession(key, agents) });
		for (const [thread, uid, room] of [['thread_1', '1', '10'], ['thread_2', '2', '20'], ['thread_3', '1', '30']]) {
			expect(resumed.get(`aiclaw-${uid}-room-${room}`)?.threadId).toBe(thread);
			const response = await endpoint.handle({ body: {
				sessionKey: `codex:${thread}`, command: 'send-message', idempotencyKey: `reply-${thread}`,
				args: { content: `reply-${thread}`, roomId: 'forged-room' },
			} });
			expect(response.status).toBe(200);
			const api = agents.find((a) => a.uid === uid)!.api as unknown as { sendMessage: ReturnType<typeof vi.fn> };
			expect(api.sendMessage).toHaveBeenCalledWith(room, `reply-${thread}`);
		}
	});

	it('persists across instances on the same path', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'aichat-codex-sess-'));
		const path = join(dir, 'sessions.json');
		const store = new FileCodexSessionStore(path);
		store.set('aiclaw-1-room-2', { threadId: 'thread_persist' });
		await store.whenPersisted(); // #166: persist is async now
		const reloaded = new FileCodexSessionStore(path);
		expect(reloaded.get('aiclaw-1-room-2')).toEqual({ threadId: 'thread_persist' });
		expect(reloaded.findKeyByThreadId('thread_persist')).toBe('aiclaw-1-room-2');
	});
});
