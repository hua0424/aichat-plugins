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

	it('package.json "openclaw.extensions" lists string paths that all exist on disk', () => {
		const pkg = readJson('package.json');
		const openclaw = pkg.openclaw;
		expect(
			openclaw !== null && typeof openclaw === 'object',
			'package.json must declare an "openclaw" object. openclaw 2026.6.5 discovers/loads ' +
				'a plugin via openclaw.extensions; without it the gateway SILENTLY skips the plugin.',
		).toBe(true);

		const extensions = (openclaw as Record<string, unknown>).extensions;
		expect(
			Array.isArray(extensions),
			'package.json "openclaw.extensions" must be an array of built entry paths.',
		).toBe(true);

		const exts = extensions as unknown[];
		expect(
			exts.length > 0,
			'package.json "openclaw.extensions" must be non-empty; an empty array means openclaw ' +
				'finds no entry and SILENTLY skips the plugin.',
		).toBe(true);

		for (const ext of exts) {
			expect(
				typeof ext,
				`package.json "openclaw.extensions" entries must be strings, got ${typeof ext}: ${String(ext)}.`,
			).toBe('string');

			const extPath = join(packageRoot, ext as string);
			expect(
				existsSync(extPath),
				`package.json "openclaw.extensions" -> "${ext as string}" does not exist at ${extPath}. ` +
					'openclaw 2026.6.5 would SILENTLY skip the plugin. Did the build run? Expected built output under dist/.',
			).toBe(true);
		}
	});

	// aichatoverview#161 (ADR-0004 收尾): Agent Tools 已退役——openclaw.plugin.json 不再声明
	// contracts.tools（回复统一走 aichat CLI，插件不注册任何 agent tool）。
	it('openclaw.plugin.json declares NO agent-tool contracts (tools retired)', () => {
		const manifest = readJson('openclaw.plugin.json');
		const contracts = manifest.contracts as Record<string, unknown> | undefined;
		const tools = contracts?.tools as unknown[] | undefined;
		expect(tools === undefined || (Array.isArray(tools) && tools.length === 0)).toBe(true);
	});

	// aichatoverview#161 Part C 回归守卫: openclaw 2026.6.5 gateway REFUSES to start if a configured
	// plugin's manifest lacks `configSchema` (`Gateway failed to start: plugin manifest requires
	// configSchema`). It must be a non-empty object schema (`{type:object, properties:{...}}`) — an
	// empty `{}` or a bare `{type:object}` is rejected. Keep it even though the plugin consumes no config.
	it('openclaw.plugin.json declares a non-empty object configSchema (openclaw gateway requires it)', () => {
		const manifest = readJson('openclaw.plugin.json');
		const schema = manifest.configSchema as Record<string, unknown> | undefined;
		expect(schema !== undefined && typeof schema === 'object', 'manifest must declare configSchema').toBe(true);
		expect((schema as Record<string, unknown>).type).toBe('object');
		const props = (schema as Record<string, unknown>).properties;
		expect(props !== null && typeof props === 'object' && Object.keys(props as object).length > 0).toBe(true);
	});
});
