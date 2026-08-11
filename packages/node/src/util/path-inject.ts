import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { delimiter, resolve, join } from 'node:path';
import { AICHAT_HOME } from '../config.js';

/**
 * aichatoverview#257 — make `aichat` resolvable inside agent shells regardless of how the
 * node was started.
 *
 * The opencode/codex/cc skills tell the agent to run the BARE `aichat send-message` command.
 * Manual deploy method A (`node packages/node/dist/cli.js start`, no `npm link`) leaves no
 * `aichat` on PATH, so the agent's shell can't resolve it and the reply chain breaks. We write
 * a tiny launcher for OUR OWN cli entry into ~/.aichat/bin and prepend that dir to PATH at
 * `aichat start` — every spawned subprocess (opencode serve → its bash tool, codex exec, cc
 * headless) inherits the env, so `aichat` resolves to this very cli. One change, all backends.
 *
 * ponytail: shims are re-written on every start (cheap), which also auto-fixes a moved install —
 * option B (absolute path baked into SKILL.md) would go stale instead.
 */

/** The CLI entry this process was launched as (prod: dist/cli.js; dev: src/cli.ts). */
export function cliEntryPath(): string {
	const entry = process.argv[1];
	return entry ? resolve(entry) : '';
}

/** Quote a path for a single-quoted POSIX sh string (embeds `'` as `'\''`). */
const shQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;
/** Quote a path for a double-quoted cmd string (embeds `"` as `""`). */
const cmdQuote = (s: string): string => `"${s.replace(/"/g, '""')}"`;

export interface ShimFile {
	name: string;
	content: string;
	/** chmod +x on POSIX (ignored on win32). */
	executable?: boolean;
}

/**
 * The launcher(s) that make `aichat` resolve to `node <cliPath> <args...>`.
 * POSIX gets an `aichat` sh script (bash/git-bash shells); win32 gets `aichat.cmd`
 * (found by both cmd and PowerShell via PATHEXT).
 */
export function renderAichatShims(nodePath: string, cliPath: string, platform: NodeJS.Platform): ShimFile[] {
	if (platform === 'win32') {
		return [{ name: 'aichat.cmd', content: `@echo off\r\n${cmdQuote(nodePath)} ${cmdQuote(cliPath)} %*\r\n` }];
	}
	return [
		{
			name: 'aichat',
			content: `#!/bin/sh\nexec ${shQuote(nodePath)} ${shQuote(cliPath)} "$@"\n`,
			executable: true,
		},
	];
}

/**
 * Write the `aichat` launcher(s) into a bin dir and prepend it to `process.env.PATH`.
 * Best-effort: returns the dir on success, null when there is no cli entry or the write
 * failed (never blocks startup). Idempotent — a second call does not duplicate the PATH entry.
 */
export function ensureAichatOnPath(opts?: {
	binDir?: string;
	cliPath?: string;
	platform?: NodeJS.Platform;
}): string | null {
	const cli = opts?.cliPath ?? cliEntryPath();
	if (!cli) return null;
	const bin = opts?.binDir ?? join(AICHAT_HOME, 'bin');
	try {
		mkdirSync(bin, { recursive: true });
		for (const shim of renderAichatShims(process.execPath, cli, opts?.platform ?? process.platform)) {
			const file = join(bin, shim.name);
			writeFileSync(file, shim.content, 'utf-8');
			if (shim.executable) chmodSync(file, 0o755);
		}
	} catch {
		return null; // best-effort
	}
	const parts = (process.env.PATH ?? '').split(delimiter).filter((p) => p && resolve(p) !== resolve(bin));
	process.env.PATH = [bin, ...parts].join(delimiter);
	return bin;
}
