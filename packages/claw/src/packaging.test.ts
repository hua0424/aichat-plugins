import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// This test file lives at packages/claw/src/, so the package root is one dir up.
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');

/**
 * Packaging contract regression (REQ-004 S2 deploy fix).
 *
 * openclaw discovers/loads aichat-claw via two resolution paths:
 *  - openclaw.plugin.json "entry"
 *  - package.json "main"
 *
 * In a containerized prod deploy (`npm install --omit=dev`) typescript is
 * stripped and only the built `dist/` output is present. If either field
 * points at a non-existent file (e.g. the old `src/index.ts`), openclaw
 * SILENTLY skips the plugin. These assertions make that failure loud: a
 * missing entry/main file fails the build with the exact path named.
 *
 * Requires `dist/` to exist — run `pnpm --filter aichat-claw build`
 * (or `pnpm build`) before this test.
 */
describe('packaging contract', () => {
	function readJson(relPath: string): Record<string, unknown> {
		const abs = join(packageRoot, relPath);
		return JSON.parse(readFileSync(abs, 'utf-8')) as Record<string, unknown>;
	}

	it('openclaw.plugin.json "entry" points to a file that exists on disk', () => {
		const manifest = readJson('openclaw.plugin.json');
		const entry = manifest.entry;
		expect(typeof entry, 'openclaw.plugin.json must declare a string "entry"').toBe('string');

		const entryPath = join(packageRoot, entry as string);
		expect(
			existsSync(entryPath),
			`openclaw.plugin.json "entry" -> "${entry as string}" does not exist at ${entryPath}. ` +
				'openclaw would silently skip the plugin. Did the build run? Expected built output under dist/.',
		).toBe(true);
	});

	it('package.json "main" points to a file that exists on disk', () => {
		const pkg = readJson('package.json');
		const main = pkg.main;
		expect(typeof main, 'package.json must declare a string "main" for openclaw entry resolution').toBe('string');

		const mainPath = join(packageRoot, main as string);
		expect(
			existsSync(mainPath),
			`package.json "main" -> "${main as string}" does not exist at ${mainPath}. ` +
				'openclaw would silently skip the plugin. Did the build run? Expected built output under dist/.',
		).toBe(true);
	});
});
