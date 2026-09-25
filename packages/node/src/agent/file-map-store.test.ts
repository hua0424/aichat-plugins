import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncJsonWriter, FileJsonMapStore } from './file-map-store.js';

vi.mock('node:fs/promises', async (importOriginal) => {
	const fs = await importOriginal<typeof import('node:fs/promises')>();
	return { ...fs, rename: vi.fn(fs.rename) };
});

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
		vi.mocked(rename).mockRejectedValueOnce(new Error('injected rename failure'));
		const writer = new AsyncJsonWriter(path);
		writer.write({ next: true });
		await expect(writer.whenWritten()).rejects.toThrow('injected rename failure');
		expect(readFileSync(path, 'utf8')).toBe('{"original":true}');
		expect(readdirSync(dir)).toEqual(['sessions.json']);
		writer.write({ next: true }); // after a failure, the next serialized commit can recover
		await writer.whenWritten();
		expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ next: true });
	});

	it('refuses a malformed legacy entry instead of silently losing its native reference', () => {
		const path = join(mkdtempSync(join(tmpdir(), 'aichat-map-invalid-')), 'sessions.json');
		writeFileSync(path, JSON.stringify({ 'aiclaw-1-room-2': { wrong: 'value' } }));
		expect(() => new FileJsonMapStore<{ threadId: string }>(path, (v) => typeof v.threadId === 'string')).toThrow();
		expect(readFileSync(path, 'utf8')).toContain('wrong');
	});

	it('rejects corrupt existing JSON instead of overwriting it with an empty map', () => {
		const path = join(mkdtempSync(join(tmpdir(), 'aichat-map-corrupt-')), 'sessions.json');
		writeFileSync(path, '{ broken');
		expect(() => new FileJsonMapStore(path, () => true)).toThrow();
		expect(readFileSync(path, 'utf8')).toBe('{ broken');
	});
});
