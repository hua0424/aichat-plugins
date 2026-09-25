import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncJsonWriter, FileJsonMapStore } from './file-map-store.js';

describe('shared JSON persistence', () => {
	it('keeps the legacy object format across serialized atomic replacements', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'aichat-map-'));
		const path = join(dir, 'sessions.json');
		const store = new FileJsonMapStore<{ threadId: string }>(path, (v) => typeof v.threadId === 'string');
		store.set('aiclaw-1-room-2', { threadId: 'one' });
		store.set('aiclaw-2-room-3', { threadId: 'two' });
		await store.whenPersisted();
		expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
			'aiclaw-1-room-2': { threadId: 'one' },
			'aiclaw-2-room-3': { threadId: 'two' },
		});
		expect(readdirSync(dir)).toEqual(['sessions.json']);
	});

	it('reports failed atomic replacement without erasing the last valid file', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'aichat-map-error-'));
		const path = join(dir, 'sessions.json');
		writeFileSync(path, '{"original":true}');
		// A directory at the target path cannot be atomically replaced by a file.
		const blocked = join(dir, 'blocked');
		mkdirSync(blocked);
		const failingWriter = new AsyncJsonWriter(blocked);
		failingWriter.write({ next: true });
		await expect(failingWriter.whenWritten()).rejects.toThrow();
		expect(readFileSync(path, 'utf8')).toBe('{"original":true}');
		expect(readdirSync(dir).sort()).toEqual(['blocked', 'sessions.json']);
	});

	it('rejects corrupt existing JSON instead of overwriting it with an empty map', () => {
		const path = join(mkdtempSync(join(tmpdir(), 'aichat-map-corrupt-')), 'sessions.json');
		writeFileSync(path, '{ broken');
		expect(() => new FileJsonMapStore(path, () => true)).toThrow();
		expect(readFileSync(path, 'utf8')).toBe('{ broken');
	});
});
