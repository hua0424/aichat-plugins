import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { platform, userInfo } from 'node:os';
import { posix as path } from 'node:path';

const VERSION = '2.1.195';
const CLI_SHA256 = '8323e70125063147a4478b957745d835a87e5e72ffd25b838ea9a841c03e6a37';
const MAX_HISTORY_BYTES = 8 * 1024 * 1024;
const MAX_CLI_BYTES = 300 * 1024 * 1024;
const MAX_SETTINGS_BYTES = 64 * 1024;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const PROFILE_ENV = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
	'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL'];
const UNSAFE_ENV = /^(?:CLAUDE(?:_|$)|ANTHROPIC(?:_|$)|XDG_|LD_|DYLD_|GLIBC_TUNABLES$|GCONV_PATH$|LOCPATH$|TZDIR$|NODE_|BUN_|GIT_|BASH_|SHELLOPTS$|ENV$|PROMPT_COMMAND$|ZDOTDIR$|TMP(?:DIR)?$|TEMP$|(?:HTTPS?|ALL|NO)_PROXY$|DISABLE_COMPACT$|MAX_RETRIES$|SSL_(?:CERT|KEYLOG)|CURL_CA_BUNDLE$)/i;
const canonical = (p: string) => /^\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+$/.test(p) && path.normalize(p) === p;
const sameIdentity = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid &&
	a.gid === b.gid && a.mode === b.mode && a.nlink === b.nlink;
const same = (a: BigIntStats, b: BigIntStats) => sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const stat = (p: string) => lstat(p, { bigint: true });

export interface CcNativeCompactPreflight {
	cwd: string;
	cliPath: string;
	settingsPath: string;
	env: NodeJS.ProcessEnv;
	assertIntact(phase?: 'native-resume'): Promise<void>;
	/** On success the caller owns this descriptor and must close it, including on cancellation. */
	history: { path: string; handle: FileHandle; originalBytes: Buffer };
}

async function absent(p: string): Promise<boolean> {
	try { await stat(p); return false; }
	catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return true; throw e; }
}

// Reject symlink or writable-by-others ancestors before opening paths the control child will reuse by name.
async function controlledDirectory(p: string, uid: bigint): Promise<boolean> {
	let current = '/';
	for (const part of ['', ...p.split('/').filter(Boolean)]) {
		current = path.join(current, part);
		const dir = await stat(current);
		if (!dir.isDirectory() || (dir.uid !== uid && dir.uid !== 0n) || (dir.mode & 0o022n) !== 0n) return false;
	}
	return true;
}

async function controlledPath(dirs: string[], uid: bigint): Promise<boolean> {
	for (const dir of dirs) {
		const target = await realpath(dir);
		if (target !== dir && !((dir === '/bin' || dir === '/sbin') && target === `/usr${dir}` && (await stat(dir)).uid === 0n)) return false;
		if (!await controlledDirectory(target, uid)) return false;
	}
	return true;
}

async function openExisting(p: string, uid: bigint, max: number) {
	const handle = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = await handle.stat({ bigint: true });
		if (!before.isFile() || before.uid !== uid || before.ino <= 0n || before.nlink !== 1n ||
			(before.mode & 0o022n) !== 0n || before.size < 1n || before.size > max || !same(before, await stat(p)))
			throw new Error('Uncontrolled CC file');
		return { handle, before, current: async () => same(before, await handle.stat({ bigint: true })) && same(before, await stat(p)) };
	} catch (e) { await handle.close(); throw e; }
}

async function readExact(handle: FileHandle, buffer: Buffer, length: number, position = 0) {
	for (let offset = 0; offset < length;) {
		const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
		if (!bytesRead) throw new Error('CC file changed during read');
		offset += bytesRead;
	}
}

async function installedCli(candidate: string, home: string, dirs: string[], uid: bigint) {
	const launcher = path.join(home, '.local/bin/claude');
	const binary = path.join(home, '.local/share/claude/versions', VERSION);
	if (candidate === 'claude') {
		for (const dir of dirs) {
			const entry = path.join(dir, 'claude');
			if (!await absent(entry)) { candidate = entry; break; }
		}
	}
	if ((candidate !== launcher && candidate !== binary) || !await controlledDirectory(path.dirname(candidate), uid) ||
		!await controlledDirectory(path.dirname(binary), uid) || (await stat(candidate)).uid !== uid || await realpath(candidate) !== binary) return;
	const file = await openExisting(binary, uid, MAX_CLI_BYTES);
	try {
		if ((file.before.mode & 0o111n) === 0n) return;
		const hash = createHash('sha256');
		const chunk = Buffer.allocUnsafe(Math.min(Number(file.before.size), 1024 * 1024));
		for (let offset = 0; offset < Number(file.before.size); offset += chunk.length) {
			const length = Math.min(chunk.length, Number(file.before.size) - offset);
			await readExact(file.handle, chunk, length, offset);
			hash.update(chunk.subarray(0, length));
		}
		if (hash.digest('hex') === CLI_SHA256 && await file.current() && await realpath(candidate) === binary)
			return { binary, before: file.before };
	} finally { await file.handle.close(); }
}

async function approvedSettings(p: string, uid: bigint): Promise<BigIntStats | undefined> {
	const file = await openExisting(p, uid, MAX_SETTINGS_BYTES);
	try {
		// Read only the settings needed for profile equivalence. Never extract or forward credentials separately.
		const bytes = Buffer.alloc(Number(file.before.size));
		await readExact(file.handle, bytes, bytes.length);
		const settings = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
		if (!settings || Object.keys(settings).length !== 1 || !Object.hasOwn(settings, 'env') ||
			!settings.env || typeof settings.env !== 'object' || Array.isArray(settings.env) ||
			Object.keys(settings.env).length !== PROFILE_ENV.length ||
			!PROFILE_ENV.every(key => Object.hasOwn(settings.env, key) && typeof settings.env[key] === 'string' && settings.env[key].length > 0)) return;
		const url = new URL(settings.env.ANTHROPIC_BASE_URL);
		if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && !url.search && !url.hash && await file.current())
			return file.before;
	} finally { await file.handle.close(); }
}

async function freshCleanupMarker(profile: string, uid: bigint): Promise<BigIntStats | undefined> {
	const marker = await stat(path.join(profile, '.last-cleanup'));
	const age = Date.now() - Number(marker.mtimeMs);
	// This exact build schedules cleanup on non-bare headless startup. Never refresh the marker;
	// leave margin beyond the entire control deadline before its native 24-hour TTL elapses.
	if (marker.isFile() && marker.uid === uid && marker.ino > 0n && marker.nlink === 1n &&
		(marker.mode & 0o022n) === 0n && age >= 0 && age < 23 * 60 * 60 * 1000) return marker;
}

function exactHistory(bytes: Buffer, cwd: string, sessionId: string): boolean {
	if (bytes.at(-1) !== 10) return false;
	let user = false, assistant = false;
	for (const line of new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, -1)).split('\n')) {
		const row = JSON.parse(line);
		if (!row || typeof row !== 'object' || typeof row.type !== 'string' ||
			('cwd' in row && row.cwd !== cwd) || ('sessionId' in row && row.sessionId !== sessionId) ||
			('version' in row && row.version !== VERSION) || ('isSidechain' in row && row.isSidechain !== false)) return false;
		if (row.type === 'user' || row.type === 'assistant' || row.type === 'system' || row.type === 'attachment') {
			if (row.cwd !== cwd || row.sessionId !== sessionId || row.version !== VERSION || row.isSidechain !== false ||
				typeof row.uuid !== 'string' || !UUID.test(row.uuid)) return false;
			if (row.type === 'user' || row.type === 'assistant') {
				if (row.message?.role !== row.type) return false;
				if (row.type === 'user') user = true; else assistant = true;
			}
		}
	}
	return user && assistant;
}

/** Linux/pinned native installation only. No probing by launch, account/project search or state creation. */
export async function prepareCcNativeCompact({ cwd, sessionId, env, cliPath, settingsPath }: {
	cwd: string; sessionId: string; env: NodeJS.ProcessEnv; cliPath: string; settingsPath?: string;
}): Promise<CcNativeCompactPreflight | undefined> {
	if (platform() !== 'linux' || !UUID.test(sessionId) || !canonical(cwd) || cwd.length > 200 ||
		Object.keys(env).some(key => UNSAFE_ENV.test(key) && !(key === 'CLAUDE_NON_INTERACTIVE' && env[key] === '1'))) return;
	try {
		const { uid: uidNumber, homedir: installHome } = userInfo();
		const home = env.HOME;
		if (!home || !canonical(home) || !canonical(installHome) || uidNumber < 0) return;
		const uid = BigInt(uidNumber);
		const profile = path.join(home, '.claude');
		const settings = path.join(profile, 'settings.json');
		const dirs = env.PATH?.split(':');
		if ((settingsPath !== undefined && settingsPath !== settings) || !dirs?.every(canonical) ||
			!await controlledDirectory(cwd, uid) || !await controlledDirectory(profile, uid) ||
			(await stat(home)).uid !== uid || (await stat(profile)).uid !== uid) return;
		const markerBefore = await freshCleanupMarker(profile, uid);
		if (!markerBefore) return;
		// Reject unverified config sources, not disable them. In particular, safe mode does not bypass managed policy.
		const fences = ['/etc/claude-code', ...['managed-settings.json', 'managed-settings.d', 'settings.d', 'settings.local.json']
			.map(name => path.join(profile, name))];
		for (let dir = cwd; ; dir = path.dirname(dir)) {
			for (const local of ['.claude', 'CLAUDE.md', '.mcp.json', '.git']) {
				const p = path.join(dir, local);
				if (p !== profile) fences.push(p);
			}
			if (dir === '/') break;
		}
		async function clearFences() {
			for (const p of fences) if (!await absent(p)) return false;
			return true;
		}
		if (!await clearFences() || !await controlledPath(dirs, uid)) return;
		const settingsBefore = await approvedSettings(settings, uid);
		if (!settingsBefore) return;
		const cli = await installedCli(cliPath, installHome, dirs, uid);
		if (!cli) return;
		// Pinned native LE() maps every non-alphanumeric byte, not just slashes. Longer or non-ASCII cwd is not admitted.
		const workspace = path.join(profile, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
		const transcript = path.join(workspace, `${sessionId}.jsonl`);
		if (!await controlledDirectory(workspace, uid) || await realpath(transcript) !== transcript) return;
		const file = await openExisting(transcript, uid, MAX_HISTORY_BYTES);
		let result: CcNativeCompactPreflight | undefined;
		try {
			const originalBytes = Buffer.alloc(Number(file.before.size));
			await readExact(file.handle, originalBytes, originalBytes.length);
			const resumeHistoryIntact = async () => {
				// Pinned resume touches the same file and may re-append its normal-mode metadata before reading input.
				const mode = Buffer.from(JSON.stringify({ type: 'mode', mode: 'normal', sessionId }) + '\n');
				const snapshot = await file.handle.stat({ bigint: true });
				const size = Number(snapshot.size);
				if (!sameIdentity(file.before, snapshot) || size > MAX_HISTORY_BYTES ||
					(size !== originalBytes.length && size !== originalBytes.length + mode.length) || !same(snapshot, await stat(transcript))) return false;
				const bytes = Buffer.alloc(size);
				await readExact(file.handle, bytes, size);
				const suffix = bytes.subarray(originalBytes.length);
				return bytes.subarray(0, originalBytes.length).equals(originalBytes) && (!suffix.length || suffix.equals(mode)) &&
					same(snapshot, await file.handle.stat({ bigint: true })) && same(snapshot, await stat(transcript));
			};
			const assertIntact = async (phase?: 'native-resume') => {
				const marker = await freshCleanupMarker(profile, uid);
				if (!marker || !same(markerBefore, marker) || !await clearFences() ||
					!await controlledDirectory(cwd, uid) || !await controlledDirectory(workspace, uid) ||
					!same(settingsBefore, await stat(settings)) || !same(cli.before, await stat(cli.binary)) ||
					!await (phase === 'native-resume' ? resumeHistoryIntact() : file.current()))
					throw new Error('Original Claude compact scope changed');
			};
			if (!exactHistory(originalBytes, cwd, sessionId)) return;
			await assertIntact();
			const childEnv: NodeJS.ProcessEnv = { HOME: home, PATH: env.PATH, CLAUDE_NON_INTERACTIVE: '1' };
			for (const key of ['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ']) if (env[key] !== undefined) childEnv[key] = env[key];
			return result = { cwd, cliPath: cli.binary, settingsPath: settings, env: childEnv, assertIntact,
				history: { path: transcript, handle: file.handle, originalBytes } };
		} finally { if (!result) await file.handle.close(); }
	} catch { /* Fail closed without emitting paths, settings or transcript contents. */ }
}
