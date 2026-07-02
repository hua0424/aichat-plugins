import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAgentRegistry, resolveAgentCredential, cacheFilePath, type AgentEntry } from './registry.js';
import type { AichatConfig } from './config.js';

/** 构造一个返回给定 JSON envelope 的 fake fetch Response */
function jsonResponse(json: unknown): Response {
	return {
		ok: true,
		status: 200,
		json: async () => json,
		text: async () => '',
	} as unknown as Response;
}

describe('loadAgentRegistry', () => {
	it('returns [] when config.agents is absent', () => {
		expect(loadAgentRegistry({} as AichatConfig)).toEqual([]);
		expect(loadAgentRegistry({ agents: undefined } as AichatConfig)).toEqual([]);
	});

	it('parses valid entries and carries through cwd/model', () => {
		const config: AichatConfig = {
			agents: [
				{ tool: 'openclaw', token: 'tok-A' },
				{ tool: 'opencode', token: 'tok-B', cwd: '/proj', model: 'gpt-x' },
			],
		};
		const out = loadAgentRegistry(config);
		expect(out).toHaveLength(2);
		expect(out[0]).toEqual({ tool: 'openclaw', token: 'tok-A' });
		expect(out[1]).toEqual({ tool: 'opencode', token: 'tok-B', cwd: '/proj', model: 'gpt-x' });
	});

	it('skips + warns invalid entries (missing/empty token or tool, non-object) without throwing', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const config = {
			agents: [
				{ tool: 'openclaw', token: 'good' },
				{ tool: 'openclaw', token: '' }, // empty token
				{ tool: 'openclaw' }, // missing token
				{ token: 'no-tool' }, // missing tool
				{ tool: '', token: 'x' }, // empty tool
				null, // non-object
				'nope', // non-object
			],
		} as unknown as AichatConfig;
		const out = loadAgentRegistry(config);
		expect(out).toEqual([{ tool: 'openclaw', token: 'good' }]);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it('dedups entries with the SAME token: keeps the first, skips + warns on the duplicate', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const config: AichatConfig = {
			agents: [
				{ tool: 'openclaw', token: 'dup-tok', cwd: '/first' },
				{ tool: 'opencode', token: 'dup-tok', cwd: '/second' },
				{ tool: 'openclaw', token: 'other-tok' },
			],
		};
		const out = loadAgentRegistry(config);
		// only the first occurrence of dup-tok survives, plus the distinct token
		expect(out).toHaveLength(2);
		expect(out[0]).toEqual({ tool: 'openclaw', token: 'dup-tok', cwd: '/first' });
		expect(out[1]).toEqual({ tool: 'openclaw', token: 'other-tok' });
		expect(warn).toHaveBeenCalled();
		// the warning references the duplicate entry index (#1)
		expect(warn.mock.calls.some((c) => String(c[0]).includes('#1'))).toBe(true);
		warn.mockRestore();
	});
});

describe('resolveAgentCredential', () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'aichat-cred-'));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	const entry: AgentEntry = { tool: 'openclaw', token: 'activation-token-123' };

	it('cache MISS → persists server STRING uid as a string, writes cache, round-trips as a cache HIT (no 2nd fetch)', async () => {
		// SERVER CONTRACT (confirmed on real server): server serializes the Java Long uid as a STRING.
		// REQ-029 (#29): keep it an opaque string end-to-end (no Number() round-trip → no >2^53 brick).
		const fetchImpl = vi.fn().mockResolvedValue(
			jsonResponse({ success: true, data: { uid: '163589881742848', connectionToken: 'conn-tok' } }),
		);

		const cred = await resolveAgentCredential(entry, {
			machineCode: 'machine-xyz',
			httpBase: 'http://host:18760/api',
			credentialsDir: dir,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});

		// returned uid is an opaque string
		expect(cred.uid).toBe('163589881742848');
		expect(typeof cred.uid).toBe('string');
		expect(cred.connectionToken).toBe('conn-tok');
		expect(cred.machineCode).toBe('machine-xyz');
		expect(typeof cred.activatedAt).toBe('string');
		expect(fetchImpl).toHaveBeenCalledTimes(1);

		// activate URL + body shape
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe('http://host:18760/api/im/aiclaw/anyTenant/activate');
		expect(JSON.parse((init as RequestInit).body as string)).toEqual({
			activationToken: 'activation-token-123',
			machineCode: 'machine-xyz',
		});

		// cache file written with a STRING uid (so a >2^53 uid can be read back exactly)
		const files = readdirSync(dir);
		expect(files).toHaveLength(1);
		const written = JSON.parse(readFileSync(join(dir, files[0]), 'utf-8'));
		expect(written.uid).toBe('163589881742848');
		expect(typeof written.uid).toBe('string');

		// second call → cache HIT (the round-trip works), fetch NOT called again
		const cred2 = await resolveAgentCredential(entry, {
			machineCode: 'machine-xyz',
			httpBase: 'http://host:18760/api',
			credentialsDir: dir,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(cred2).toEqual(cred);
		expect(cred2.uid).toBe('163589881742848');
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('recovers a STRING-uid cache file: normalizes uid to a string, cache HIT (no fetch)', async () => {
		// REQ-029 (#29): uid is an opaque string. A cache file with a STRING uid reads back verbatim as a
		// string (no Number() round-trip), so the identity recovers on next boot without re-activating.
		const path = cacheFilePath(entry.token, dir);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({
				uid: '163589881742848',
				connectionToken: 'legacy-conn',
				machineCode: 'legacy-mc',
				activatedAt: '2026-01-01T00:00:00.000Z',
			}),
			'utf-8',
		);

		const fetchImpl = vi.fn();
		const cred = await resolveAgentCredential(entry, {
			machineCode: 'machine-xyz',
			httpBase: 'http://host:18760/api',
			credentialsDir: dir,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});

		expect(cred.uid).toBe('163589881742848');
		expect(typeof cred.uid).toBe('string');
		expect(cred.connectionToken).toBe('legacy-conn');
		expect(cred.machineCode).toBe('legacy-mc');
		// cache HIT → fetch never called (no re-activate → no 「已激活」 brick)
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('REQ-029 (#29): recovers a LEGACY NUMBER-uid cache file → normalizes uid to a string (backward-compat)', async () => {
		// Older builds wrote uid as a JSON number. readCachedCredential must still read it and normalize
		// to a string so those identities are not bricked on upgrade.
		const path = cacheFilePath(entry.token, dir);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({ uid: 7, connectionToken: 'legacy-num', machineCode: 'legacy-mc', activatedAt: 'x' }),
			'utf-8',
		);
		const fetchImpl = vi.fn();
		const cred = await resolveAgentCredential(entry, {
			machineCode: 'm',
			httpBase: 'http://h/api',
			credentialsDir: dir,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(cred.uid).toBe('7');
		expect(typeof cred.uid).toBe('string');
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('REQ-029 (#29): a server STRING uid > 2^53 is persisted + read back EXACTLY (Number() would corrupt)', async () => {
		// Number('9007199254740993') === 9007199254740992 — a Number() round-trip would brick this uid.
		const bigUid = '9007199254740993';
		const writeFetch = vi
			.fn()
			.mockResolvedValue(jsonResponse({ success: true, data: { uid: bigUid, connectionToken: 'c' } }));
		const cred = await resolveAgentCredential(entry, {
			machineCode: 'm',
			httpBase: 'http://h/api',
			credentialsDir: dir,
			fetchImpl: writeFetch as unknown as typeof fetch,
		});
		expect(cred.uid).toBe(bigUid);
		// the write path persisted the exact string...
		const files = readdirSync(dir);
		const written = JSON.parse(readFileSync(join(dir, files[0]), 'utf-8'));
		expect(written.uid).toBe(bigUid);
		expect(typeof written.uid).toBe('string');
		// ...and a fresh read round-trips the exact string (cache HIT, no re-activate).
		const readFetch = vi.fn();
		const cred2 = await resolveAgentCredential(entry, {
			machineCode: 'm',
			httpBase: 'http://h/api',
			credentialsDir: dir,
			fetchImpl: readFetch as unknown as typeof fetch,
		});
		expect(cred2.uid).toBe(bigUid);
		expect(readFetch).not.toHaveBeenCalled();
	});

	it('cache HIT → returns cached without calling fetch', async () => {
		// prime the cache via a first MISS
		const primeFetch = vi
			.fn()
			.mockResolvedValue(jsonResponse({ success: true, data: { uid: 7, connectionToken: 'c7' } }));
		await resolveAgentCredential(entry, {
			machineCode: 'm7',
			httpBase: 'http://h/api',
			credentialsDir: dir,
			fetchImpl: primeFetch as unknown as typeof fetch,
		});

		// now a fresh fetch spy must NOT be called
		const fetchImpl = vi.fn();
		const cred = await resolveAgentCredential(entry, {
			machineCode: 'm7',
			httpBase: 'http://h/api',
			credentialsDir: dir,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(cred.uid).toBe('7');
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('throws with server msg when success:false', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ success: false, msg: '激活码无效' }));
		await expect(
			resolveAgentCredential(entry, {
				machineCode: 'm',
				httpBase: 'http://h/api',
				credentialsDir: dir,
				fetchImpl: fetchImpl as unknown as typeof fetch,
			}),
		).rejects.toThrow('激活码无效');
		// no cache written on failure
		expect(existsSync(dir) ? readdirSync(dir).length : 0).toBe(0);
	});

	it('throws an UNRECOVERABLE error (rebuild aiclaw) when activate reports 已激活 but no local cache', async () => {
		// REQ-008 #76 硬约束：activate 非幂等 + 激活码不可再查；「已激活但无缓存」= 永久不可恢复。
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ success: false, msg: '该AI助理已激活' }));
		await expect(
			resolveAgentCredential(entry, {
				machineCode: 'm',
				httpBase: 'http://h/api',
				credentialsDir: dir,
				fetchImpl: fetchImpl as unknown as typeof fetch,
			}),
		).rejects.toThrow(/不可恢复.*重建/s);
		expect(existsSync(dir) ? readdirSync(dir).length : 0).toBe(0);
	});

	it('throws when fetch itself rejects (network error)', async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
		await expect(
			resolveAgentCredential(entry, {
				machineCode: 'm',
				httpBase: 'http://h/api',
				credentialsDir: dir,
				fetchImpl: fetchImpl as unknown as typeof fetch,
			}),
		).rejects.toThrow('ECONNREFUSED');
	});
});
