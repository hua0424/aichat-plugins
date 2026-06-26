import { describe, it, expect, vi, beforeEach } from 'vitest';

const writes: Array<{ path: string; content: string }> = [];
let throwForPath: ((path: string) => boolean) | null = null;

vi.mock('node:fs', () => ({
	mkdirSync: vi.fn(),
	writeFileSync: vi.fn((path: string, content: string) => {
		if (throwForPath?.(path)) throw new Error('boom');
		writes.push({ path, content });
	}),
}));

vi.mock('node:os', () => ({
	homedir: vi.fn(() => '/home/test'),
}));

// import AFTER mocks are registered
import { installSkill } from './skill.js';

const ROOTS = [
	'/home/test/.config/opencode/skills',
	'/home/test/.claude/skills',
	'/home/test/.agents/skills',
];

describe('installSkill (REQ-010 — install aichat-reply + aichat-query skills)', () => {
	beforeEach(() => {
		writes.length = 0;
		throwForPath = null;
	});

	it('writes BOTH aichat-reply and aichat-query SKILL.md into each of the three roots (6 writes)', () => {
		const result = installSkill();

		expect(result).toHaveLength(6);
		expect(writes).toHaveLength(6);

		for (const root of ROOTS) {
			const replyPath = `${root}/aichat-reply/SKILL.md`;
			const queryPath = `${root}/aichat-query/SKILL.md`;
			expect(writes.some((w) => w.path === replyPath)).toBe(true);
			expect(writes.some((w) => w.path === queryPath)).toBe(true);
			expect(result).toContain(replyPath);
			expect(result).toContain(queryPath);
		}
	});

	it('aichat-query content documents the id-based --groupid usage', () => {
		installSkill();
		const query = writes.find((w) => w.path.endsWith('aichat-query/SKILL.md'));
		expect(query).toBeDefined();
		const md = query!.content;
		expect(md).toContain('name: aichat-query');
		expect(md).toContain('--groupid <id>');
		expect(md).toContain('list-groups');
		expect(md).toMatch(/`id`/);
	});

	it('aichat-reply content is unchanged (still send-message based)', () => {
		installSkill();
		const reply = writes.find((w) => w.path.endsWith('aichat-reply/SKILL.md'));
		expect(reply).toBeDefined();
		expect(reply!.content).toContain('name: aichat-reply');
		expect(reply!.content).toContain('aichat send-message --content');
	});

	it('best-effort: a root that throws is skipped, others still written, no throw', () => {
		throwForPath = (p) => p.startsWith('/home/test/.claude/skills');
		const result = installSkill();
		// 2 remaining roots × 2 skills = 4 successful writes
		expect(result).toHaveLength(4);
		expect(result.every((p) => !p.startsWith('/home/test/.claude/skills'))).toBe(true);
	});
});
