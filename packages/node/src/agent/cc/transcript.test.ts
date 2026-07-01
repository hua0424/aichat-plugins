import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileCcTranscriptWriter, type CcTranscriptRecord } from './transcript.js';

const tmpDirs: string[] = [];
function freshDir(): string {
	const d = mkdtempSync(join(tmpdir(), 'cc-transcript-'));
	tmpDirs.push(d);
	return d;
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

const BINDING = 'aiclaw-5-room-9';

function readRecords(dir: string, binding: string): CcTranscriptRecord[] {
	const path = join(dir, `${binding}.jsonl`);
	if (!existsSync(path)) return [];
	return readFileSync(path, 'utf-8')
		.split('\n')
		.filter((l) => l.trim().length > 0)
		.map((l) => JSON.parse(l) as CcTranscriptRecord);
}

describe('FileCcTranscriptWriter', () => {
	it('append writes one JSONL record per call, under a per-binding file', () => {
		const dir = freshDir();
		const w = new FileCcTranscriptWriter(dir);
		w.append(BINDING, { ts: 1, kind: 'inbound', session_id: 'sid-1', text: '[HuLa 私聊]\n[u(100)]: hi' });

		const recs = readRecords(dir, BINDING);
		expect(recs).toHaveLength(1);
		expect(recs[0]).toEqual({ ts: 1, kind: 'inbound', session_id: 'sid-1', text: '[HuLa 私聊]\n[u(100)]: hi' });
	});

	it('appends (never overwrites) across calls — the owner sees the full session, persisted', () => {
		const dir = freshDir();
		const w = new FileCcTranscriptWriter(dir);
		w.append(BINDING, { ts: 1, kind: 'inbound', session_id: 'sid-1', text: 'turn-1 in' });
		w.append(BINDING, { ts: 2, kind: 'assistant', session_id: 'sid-1', text: 'turn-1 out' });
		// a later turn (new writer instance = simulates a restart) appends, does not truncate
		const w2 = new FileCcTranscriptWriter(dir);
		w2.append(BINDING, { ts: 3, kind: 'inbound', session_id: 'sid-1', text: 'turn-2 in' });

		const recs = readRecords(dir, BINDING);
		expect(recs.map((r) => r.text)).toEqual(['turn-1 in', 'turn-1 out', 'turn-2 in']);
	});

	it('separates rooms into separate files', () => {
		const dir = freshDir();
		const w = new FileCcTranscriptWriter(dir);
		w.append('aiclaw-5-room-9', { ts: 1, kind: 'inbound', text: 'room9' });
		w.append('aiclaw-5-room-10', { ts: 1, kind: 'inbound', text: 'room10' });
		expect(readRecords(dir, 'aiclaw-5-room-9').map((r) => r.text)).toEqual(['room9']);
		expect(readRecords(dir, 'aiclaw-5-room-10').map((r) => r.text)).toEqual(['room10']);
	});

	it('a write failure (bad dir) degrades to a no-op rather than throwing', () => {
		// point the dir at a path whose parent is a FILE → mkdir/append fail; must not throw.
		const dir = freshDir();
		const w = new FileCcTranscriptWriter(join(dir, 'a-file-not-a-dir\0bad'));
		expect(() => w.append(BINDING, { ts: 1, kind: 'inbound', text: 'x' })).not.toThrow();
	});
});
