import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { renderAichatShims, ensureAichatOnPath, cliEntryPath } from './path-inject.js';

const savedPath = process.env.PATH;

afterEach(() => {
	process.env.PATH = savedPath;
});

describe('renderAichatShims', () => {
	// aichatoverview#257 — the skill tells the agent to run the bare `aichat` command; the
	// launcher shim execs the SAME node + cli entry this process was started with, so the
	// agent's `aichat send-message` resolves even when the owner deployed method A (no npm link).
	it('posix → executable `aichat` sh script that execs node+cli with "$@"', () => {
		const shims = renderAichatShims('/usr/bin/node', '/opt/app/dist/cli.js', 'linux');
		expect(shims).toHaveLength(1);
		expect(shims[0].name).toBe('aichat');
		expect(shims[0].executable).toBe(true);
		expect(shims[0].content).toBe("#!/bin/sh\nexec '/usr/bin/node' '/opt/app/dist/cli.js' \"$@\"\n");
	});

	it('win32 → aichat.cmd that runs node+cli with %*', () => {
		const shims = renderAichatShims('C:\\node.exe', 'C:\\app\\dist\\cli.js', 'win32');
		expect(shims).toHaveLength(1);
		expect(shims[0].name).toBe('aichat.cmd');
		expect(shims[0].content).toBe('@echo off\r\n"C:\\node.exe" "C:\\app\\dist\\cli.js" %*\r\n');
	});

	it('escapes quotes/spaces in paths (posix sh + cmd)', () => {
		const posix = renderAichatShims('/n ode', "/app/cli'x.js", 'linux');
		expect(posix[0].content).toContain("'/n ode'");
		expect(posix[0].content).toContain("'/app/cli'\\''x.js'");
		const win = renderAichatShims('C:\\no"de', 'C:\\a b\\cli.js', 'win32');
		expect(win[0].content).toContain('"C:\\no""de"');
		expect(win[0].content).toContain('"C:\\a b\\cli.js"');
	});
});

describe('ensureAichatOnPath', () => {
	it('writes the shim, prepends the bin dir to PATH exactly once', () => {
		const bin = mkdtempSync(join(tmpdir(), 'aichat-bin-'));
		try {
			const dir = ensureAichatOnPath({ binDir: bin, cliPath: '/abs/dist/cli.js', platform: 'linux' });
			expect(dir).toBe(bin);

			const sh = readFileSync(join(bin, 'aichat'), 'utf-8');
			expect(sh).toContain(`exec '${process.execPath}' '/abs/dist/cli.js' "$@"`);
			expect(statSync(join(bin, 'aichat')).mode & 0o111).toBeTruthy();

			const parts = process.env.PATH!.split(delimiter);
			expect(parts[0]).toBe(bin);

			// idempotent: a second call does not duplicate the entry
			ensureAichatOnPath({ binDir: bin, cliPath: '/abs/dist/cli.js', platform: 'linux' });
			expect(process.env.PATH!.split(delimiter).filter((p) => p === bin)).toHaveLength(1);
		} finally {
			rmSync(bin, { recursive: true, force: true });
		}
	});

	it('returns null (no throw) when there is no cli entry to shim', () => {
		expect(ensureAichatOnPath({ binDir: 'x', cliPath: '' })).toBeNull();
		// PATH untouched
		expect(process.env.PATH).toBe(savedPath);
	});
});

describe('cliEntryPath', () => {
	it('resolves the running entry script to an absolute path', () => {
		const p = cliEntryPath();
		expect(p.length).toBeGreaterThan(0);
		expect(isAbsolute(p)).toBe(true);
	});
});
