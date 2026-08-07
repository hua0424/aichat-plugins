import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	upsertSystemBlock,
	needsSystemBlockUpdate,
	syncAgentsMdFile,
	AICHAT_SYSTEM_BEGIN,
	AICHAT_SYSTEM_END,
} from './agents-md.js';

// REQ-018 — the AGENTS.md marked block (codex/openclaw shared). Pure upsert/hash-compare + a tiny
// read/upsert/write-if-changed IO helper. Both drivers write the SAME marked block so an older block
// from the other driver is replaced, never duplicated.
const CONTENT = '你是助手\n要回复时运行 aichat send-message';

describe('agents-md marked block (REQ-018)', () => {
	it('upsertSystemBlock with NO existing block → appends the block at the end, outside content preserved', () => {
		const existing = '# AGENTS.md\n\nsome instructions\n';
		const out = upsertSystemBlock(existing, CONTENT);
		// outside content is preserved verbatim (leading part unchanged)
		expect(out.startsWith('# AGENTS.md\n\nsome instructions\n')).toBe(true);
		// block appended AFTER the existing content (begin marker index > existing length)
		expect(out).toContain(AICHAT_SYSTEM_BEGIN);
		expect(out).toContain(AICHAT_SYSTEM_END);
		expect(out.indexOf(AICHAT_SYSTEM_BEGIN)).toBeGreaterThan(existing.length - 1);
	});

	it('upsertSystemBlock with an existing block → replaces ONLY inside the markers, outside content preserved byte-for-byte', () => {
		const head = 'title: AGENTS\n\ndescription: foo';
		const tail = '\n# Notes\nkeep me';
		const withBlock = `${head}\n\n${upsertSystemBlock('', 'OLD CONTENT')}${tail}`;
		const out = upsertSystemBlock(withBlock, CONTENT);
		expect(out.startsWith(head)).toBe(true);
		expect(out.endsWith(tail)).toBe(true);
		expect(out).not.toContain('OLD CONTENT');
		expect(out).toContain(CONTENT);
		expect(out).toContain('keep me');
	});

	it('upsertSystemBlock is idempotent: upsert(upsert("",c),c) === upsert("",c)', () => {
		const once = upsertSystemBlock('', CONTENT);
		expect(upsertSystemBlock(once, CONTENT)).toBe(once);
	});

	it('needsSystemBlockUpdate: true for a doc without the block; false after upserting the same content', () => {
		expect(needsSystemBlockUpdate('', CONTENT)).toBe(true);
		const withBlock = upsertSystemBlock('', CONTENT);
		expect(needsSystemBlockUpdate(withBlock, CONTENT)).toBe(false);
	});

	it('syncAgentsMdFile writes to a mkdtemp dir; second call with same content returns false and leaves the file unchanged', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'agents-md-'));
		try {
			const file = join(dir, 'AGENTS.md');
			const first = await syncAgentsMdFile(file, CONTENT);
			expect(first).toBe(true);
			const content = readFileSync(file, 'utf-8');
			expect(content).toContain(AICHAT_SYSTEM_BEGIN);
			expect(content).toContain(AICHAT_SYSTEM_END);
			expect(content).toContain(CONTENT);

			const second = await syncAgentsMdFile(file, CONTENT);
			expect(second).toBe(false);
			expect(readFileSync(file, 'utf-8')).toBe(content); // byte-identical (no rewrite)
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
