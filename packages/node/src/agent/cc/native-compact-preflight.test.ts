import { constants } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { prepareCcNativeCompact } from './native-compact-preflight.js';

const PIN = '8323e70125063147a4478b957745d835a87e5e72ffd25b838ea9a841c03e6a37';
const home = '/root';
const profile = '/root/.claude';
const cwd = '/root/.aichat/cc/work_space';
const launcher = '/root/.local/bin/claude';
const binary = '/root/.local/share/claude/versions/2.1.195';
const sessionId = '350134b9-5bf9-49ab-b755-1868c400019b';
const historyPath = `${profile}/projects/-root--aichat-cc-work-space/${sessionId}.jsonl`;
const now = 1_800_000_000_000;

type FixtureEntry = {
	kind: 'directory' | 'file' | 'link'; ino: number; uid: number; mode: number; nlink: number;
	mtimeMs: number; bytes: Buffer; alias?: string; size?: number;
};
const approvedEnv = {
	ANTHROPIC_AUTH_TOKEN: 'fictional-test-credential', ANTHROPIC_BASE_URL: 'https://example.invalid', ANTHROPIC_MODEL: 'fictional',
	ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku', ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet', ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus',
};
const fake = vi.hoisted(() => ({
	entries: new Map<string, FixtureEntry>(),
	open: vi.fn(), close: vi.fn(), read: vi.fn(), digest: vi.fn(), platform: vi.fn(() => 'linux'),
}));
vi.mock('node:os', () => ({ platform: fake.platform, userInfo: () => ({ homedir: '/root', uid: 0 }) }));
vi.mock('node:crypto', () => ({ createHash: () => ({ update: vi.fn(), digest: fake.digest }) }));
vi.mock('node:fs/promises', () => {
	const lookup = (path: string) => {
		const entry = fake.entries.get(path);
		if (!entry) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
		return entry;
	};
	const stat = (entry: FixtureEntry) => ({ dev: 9n, ino: BigInt(entry.ino), uid: BigInt(entry.uid), mode: BigInt(entry.mode),
		nlink: BigInt(entry.nlink), size: BigInt(entry.size ?? entry.bytes.length), mtimeMs: BigInt(entry.mtimeMs),
		ctimeNs: BigInt(entry.mtimeMs) * 1_000_000n, mtimeNs: BigInt(entry.mtimeMs) * 1_000_000n,
		isFile: () => entry.kind === 'file', isDirectory: () => entry.kind === 'directory' });
	return {
		lstat: async (path: string) => stat(lookup(path)),
		realpath: async (path: string) => lookup(path).alias ?? path,
		open: async (path: string, flags: number) => {
			fake.open(path, flags);
			const entry = lookup(path);
			return {
				stat: async () => stat(entry),
				close: async () => { fake.close(path); },
				read: async (buf: Buffer, offset: number, length: number, position: number) => {
					fake.read(path);
					return { bytesRead: entry.bytes.copy(buf, offset, position, position + length) };
				},
			};
		},
	};
});

const rows = (overrides = {}) => Buffer.from(['user', 'assistant'].map((type, index) => JSON.stringify({
	type, sessionId, cwd, version: '2.1.195', isSidechain: false,
	uuid: `c98acc6a-33be-4e05-ab26-c2d441eb1f1${index}`, message: { role: type, content: '(fictional)' }, ...overrides,
})).join('\n') + '\n');

function fixture() {
	vi.spyOn(Date, 'now').mockReturnValue(now);
	fake.platform.mockReturnValue('linux');
	fake.digest.mockReturnValue(PIN);
	fake.entries.clear(); fake.open.mockClear(); fake.close.mockClear(); fake.read.mockReset();
	const place = (path: string, kind: FixtureEntry['kind'] = 'directory', bytes = Buffer.alloc(0)) => {
		const entry = { kind, ino: fake.entries.size + 16, uid: 0, mode: kind === 'directory' ? 0o755 : 0o644,
			nlink: 1, mtimeMs: now - 1000, bytes };
		fake.entries.set(path, entry);
		return entry;
	};
	for (const path of ['/', home, profile, `${home}/.local`, `${home}/.local/bin`, `${home}/.local/share`,
		`${home}/.local/share/claude`, `${home}/.local/share/claude/versions`, `${home}/.aichat`, `${home}/.aichat/cc`, cwd,
		`${profile}/projects`, `${profile}/projects/-root--aichat-cc-work-space`, '/usr', '/usr/bin']) place(path);
	place(launcher, 'link');
	fake.entries.get(launcher)!.alias = binary;
	place(binary, 'file', Buffer.from('synthetic CLI bytes')).mode = 0o755;
	place(`${profile}/.last-cleanup`, 'file');
	place(`${profile}/settings.json`, 'file', Buffer.from(JSON.stringify({ env: approvedEnv })));
	place(historyPath, 'file', rows());
	const env = { HOME: home, PATH: `${home}/.local/bin:/usr/bin`, AICHAT_RUN_BIND: 'do-not-forward', OPENCLAW_BIND: 'do-not-forward' };
	return { place, env, run: (overrides = {}) => prepareCcNativeCompact({ cwd, sessionId, env, cliPath: 'claude', ...overrides }) };
}

afterEach(() => vi.restoreAllMocks());

it('pins the default launch candidate and returns the exact native profile and original transcript without reply authority', async () => {
	const { run, env } = fixture();
	const result = await run();
	expect(result).toMatchObject({ cwd, cliPath: binary, settingsPath: `${profile}/settings.json`,
		env: { HOME: home, PATH: env.PATH, CLAUDE_NON_INTERACTIVE: '1' }, history: { path: historyPath, originalBytes: rows() } });
	if (!result) throw new Error('expected accepted preflight');
	expect(Object.keys(result.env).sort()).toEqual(['CLAUDE_NON_INTERACTIVE', 'HOME', 'PATH']);
	expect(fake.open).toHaveBeenCalledWith(historyPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	expect(fake.close).not.toHaveBeenCalledWith(historyPath);
	await result.history.handle.close();
});

it('uses an owned process HOME without moving the pinned installation or opening passwd-home history', async () => {
	const { place, run, env } = fixture();
	const owned = '/opt/issue506-private';
	const ownedCwd = `${owned}/workspace`;
	const ownedProfile = `${owned}/.claude`;
	const ownedProject = `${ownedProfile}/projects/-opt-issue506-private-workspace`;
	const ownedHistory = `${ownedProject}/${sessionId}.jsonl`;
	for (const dir of ['/opt', owned, ownedCwd, ownedProfile, `${ownedProfile}/projects`, ownedProject]) place(dir).mode = 0o700;
	place(`${ownedProfile}/.last-cleanup`, 'file');
	place(`${ownedProfile}/settings.json`, 'file', Buffer.from(JSON.stringify({ env: approvedEnv })));
	place(ownedHistory, 'file', rows({ cwd: ownedCwd }));
	const input = { cwd: ownedCwd, env: { ...env, HOME: owned } };
	const result = await run(input);
	expect(result).toMatchObject({ cliPath: binary, env: { HOME: owned }, history: { path: ownedHistory } });
	expect(fake.open).not.toHaveBeenCalledWith(historyPath, expect.any(Number));
	await result?.history.handle.close();
	place(owned).uid = 1000;
	await expect(run(input)).resolves.toBeUndefined();
});

it('accepts the explicit native launcher or canonical binary and no other alias', async () => {
	const { place, run } = fixture();
	for (const cliPath of [launcher, binary]) {
		const result = await run({ cliPath, settingsPath: `${profile}/settings.json` });
		expect(result?.cliPath).toBe(binary);
		await result?.history.handle.close();
	}
	place('/usr/bin/claude', 'link').alias = binary;
	await expect(run({ cliPath: '/usr/bin/claude' })).resolves.toBeUndefined();
});

it('rejects a shadowed PATH, an uncontrolled directory, relative PATH entries and the wrong CLI digest', async () => {
	const { place, run, env } = fixture();
	place('/usr/bin/claude', 'file', Buffer.from('wrapper'));
	await expect(run({ env: { ...env, PATH: `/usr/bin:${env.PATH}` } })).resolves.toBeUndefined();
	await expect(run({ env: { ...env, PATH: `.:${env.PATH}` } })).resolves.toBeUndefined();
	place('/usr/bin').mode = 0o777;
	await expect(run()).resolves.toBeUndefined();
	place('/usr/bin');
	fake.digest.mockReturnValue('different');
	await expect(run()).resolves.toBeUndefined();
	expect(fake.open.mock.calls.map(([path]) => path)).not.toContain(historyPath);
});

it.each(['CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'ANTHROPIC_AUTH_TOKEN', 'LD_PRELOAD', 'GIT_CONFIG_GLOBAL', 'BASH_ENV'])('rejects a supplied %s rather than overriding it', async (key) => {
	const { run, env } = fixture();
	await expect(run({ env: { ...env, [key]: 'fictional' } })).resolves.toBeUndefined();
	expect(fake.open).not.toHaveBeenCalled();
});

it('does not inspect files for unsupported OS, foreign home, invalid session ID or non-canonical workspace', async () => {
	const { run, env } = fixture();
	fake.platform.mockReturnValue('darwin');
	await expect(run()).resolves.toBeUndefined();
	fake.platform.mockReturnValue('linux');
	await expect(run({ env: { ...env, HOME: '/someone-else' } })).resolves.toBeUndefined();
	await expect(run({ sessionId: '../../foreign' })).resolves.toBeUndefined();
	await expect(run({ cwd: `${cwd}/../work_space` })).resolves.toBeUndefined();
	await expect(run({ cwd: `/${'a'.repeat(200)}` })).resolves.toBeUndefined();
	expect(fake.open).not.toHaveBeenCalled();
});

it('does not touch an absent, stale, symlinked, future, or writable housekeeping marker', async () => {
	const { run, place } = fixture();
	const name = `${profile}/.last-cleanup`;
	fake.entries.delete(name);
	await expect(run()).resolves.toBeUndefined();
	place(name, 'file').mtimeMs = now - 24 * 60 * 60 * 1000;
	await expect(run()).resolves.toBeUndefined();
	place(name, 'link');
	await expect(run()).resolves.toBeUndefined();
	place(name, 'file').mtimeMs = now + 1000;
	await expect(run()).resolves.toBeUndefined();
	place(name, 'file').mode = 0o664;
	await expect(run()).resolves.toBeUndefined();
	expect(fake.open).not.toHaveBeenCalled();
});

it('refuses ambiguous setting sources and a foreign writable profile', async () => {
	const { place, run } = fixture();
	await expect(run({ settingsPath: `${cwd}/settings.json` })).resolves.toBeUndefined();
	for (const name of ['/etc/claude-code', `${cwd}/.claude`, `${profile}/settings.local.json`]) {
		place(name, 'link');
		await expect(run()).resolves.toBeUndefined();
		fake.entries.delete(name);
	}
	place(profile).uid = 1000;
	await expect(run()).resolves.toBeUndefined();
	place(profile).mode = 0o775;
	await expect(run()).resolves.toBeUndefined();
	expect(fake.open).not.toHaveBeenCalled();
});

it('rejects settings that could introduce another policy, hook, or runtime env', async () => {
	const { place, run } = fixture();
	for (const settings of [{ env: approvedEnv, hooks: {} }, { env: { ...approvedEnv, LD_PRELOAD: 'fake' } },
		{ env: { ...approvedEnv, ANTHROPIC_BASE_URL: 'file:///untrusted' } }, { env: {} }]) {
		place(`${profile}/settings.json`, 'file', Buffer.from(JSON.stringify(settings)));
		await expect(run()).resolves.toBeUndefined();
	}
	expect(fake.open.mock.calls.map(([path]) => path)).not.toContain(binary);
});

it('rejects missing, symlinked, hardlinked or oversized original history and never scans for a replacement', async () => {
	const { place, run } = fixture();
	fake.entries.delete(historyPath);
	await expect(run()).resolves.toBeUndefined();
	place(historyPath, 'link').alias = `${profile}/other.jsonl`;
	await expect(run()).resolves.toBeUndefined();
	place(historyPath, 'file', rows()).nlink = 2;
	await expect(run()).resolves.toBeUndefined();
	place(historyPath, 'file', rows()).size = 8 * 1024 * 1024 + 1;
	await expect(run()).resolves.toBeUndefined();
	expect(fake.read).not.toHaveBeenCalledWith(historyPath);
	expect(fake.close.mock.calls.filter(([path]) => path === historyPath)).toHaveLength(2);
});

it('rejects non-matching native transcript identity and invalid JSONL', async () => {
	const { place, run } = fixture();
	for (const content of [rows({ cwd: `${cwd}2` }), rows({ sessionId: '00000000-0000-0000-0000-000000000000' }),
		rows({ version: '2.1.194' }), rows({ isSidechain: true }), rows({ type: 'assistant' }),
		rows().subarray(0, -1), Buffer.from('not json\n')]) {
		place(historyPath, 'file', content);
		await expect(run()).resolves.toBeUndefined();
	}
	expect(fake.close.mock.calls.filter(([path]) => path === historyPath)).toHaveLength(7);
});

it('allows only the original transcript plus pinned normal-mode metadata after native resume', async () => {
	const { run } = fixture();
	const result = await run();
	if (!result) throw new Error('expected accepted preflight');
	const history = fake.entries.get(historyPath)!;
	const mode = (overrides = {}) => Buffer.from(JSON.stringify({ type: 'mode', mode: 'normal', sessionId, ...overrides }) + '\n');
	try {
		history.mtimeMs++;
		await expect(result.assertIntact()).rejects.toThrow('scope changed');
		await expect(result.assertIntact('native-resume')).resolves.toBeUndefined();
		history.bytes = Buffer.concat([rows(), mode()]);
		await expect(result.assertIntact('native-resume')).resolves.toBeUndefined();
		for (const suffix of [mode({ mode: 'coordinator' }), mode({ sessionId: 'other' }), mode({ extra: true }), Buffer.concat([mode(), mode()])]) {
			history.bytes = Buffer.concat([rows(), suffix]);
			await expect(result.assertIntact('native-resume')).rejects.toThrow('scope changed');
		}
		history.bytes = Buffer.concat([rows({ version: '2.1.194' }), mode()]);
		await expect(result.assertIntact('native-resume')).rejects.toThrow('scope changed');
		history.bytes = Buffer.concat([rows(), mode()]);
		history.nlink = 2;
		await expect(result.assertIntact('native-resume')).rejects.toThrow('scope changed');
	} finally { await result.history.handle.close(); }
});

it.each([historyPath, `${profile}/settings.json`, binary, `${profile}/.last-cleanup`, '/etc/claude-code'])('closes and rejects if %s changes while reading history', async (changedPath) => {
	const { place, run } = fixture();
	fake.read.mockImplementation((path: string) => {
		if (path !== historyPath) return;
		if (changedPath === '/etc/claude-code') place(changedPath);
		else {
			const previous = fake.entries.get(changedPath)!;
			fake.entries.set(changedPath, { ...previous, ino: previous.ino + 100 });
		}
	});
	await expect(run()).resolves.toBeUndefined();
	expect(fake.close).toHaveBeenCalledWith(historyPath);
});
