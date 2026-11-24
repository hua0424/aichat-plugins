import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { open, mkdtemp, realpath, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { observeCcCompact, verifyCcCompactAppend } from './compact.js';
import type { CcSpawnFn } from './headless-driver.js';

const sessionId = '350134b9-5bf9-49ab-b755-1868c400019b';
const inputId = '94f1a809-4687-4f8f-8a80-0dc54fd7276c';
const controlId = 'e93a3c97-8d67-4db8-947a-9012b59e88cf';
const summaryId = '86b6f7c7-48de-4bc2-98a2-893869878277';
const displayId = '60a8e918-37bb-4f26-8109-76a99c7b7805';
const summary = 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSynthetic fixture.';
const cwd = process.cwd();
function fixture() {
	const child = Object.assign(new EventEmitter(), {
		pid: 4242, stdin: { write: vi.fn<(chunk: string) => void>(), end: vi.fn() },
		stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(() => true),
	});
	const spawn = vi.fn<CcSpawnFn>(() => child);
	let groupAlive = true;
	const kill = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
		if (pid === -child.pid && signal === 0 && !groupAlive) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
	});
	const assertCurrent = vi.fn();
	const start = () => observeCcCompact({ cwd, sessionId, inputId, version: '2.1.195', claudeBin: '/owned/claude',
		settingsPath: '/owned/settings.json', env: { HOME: '/owned/home' }, signal: new AbortController().signal,
		assertCurrent, spawn, kill, platform: 'linux' });
	const line = (value: object) => child.stdout.emit('data', JSON.stringify(value) + '\n');
	const lines = () => child.stdin.write.mock.calls.map(([line]) => JSON.parse(line));
	const ack = (requestId = lines()[0].request_id) => line({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: {} } });
	return { child, spawn, assertCurrent, start, lines, ack,
		progress: () => {
			line({ type: 'system', subtype: 'status', session_id: sessionId, status: 'compacting' });
			line({ type: 'system', subtype: 'status', session_id: sessionId, status: null, compact_result: 'success' });
		},
		init: () => line({ type: 'system', subtype: 'init', session_id: sessionId, cwd, claude_code_version: '2.1.195', permissionMode: 'default', tools: [], mcp_servers: [] }),
		boundary: (trigger = 'manual') => line({ type: 'system', subtype: 'compact_boundary', uuid: controlId, session_id: sessionId, compact_metadata: { trigger, pre_tokens: 1570, post_tokens: 1213 } }),
		summary: () => line({ type: 'user', uuid: summaryId, session_id: sessionId, parent_tool_use_id: null, isSynthetic: true, isReplay: false, message: { role: 'user', content: summary } }),
		display: () => line({ type: 'user', uuid: displayId, session_id: sessionId, parent_tool_use_id: null, isReplay: true, timestamp: '2026-11-24T02:00:00.000Z', message: { role: 'user', content: '<local-command-stdout>Compacted native display</local-command-stdout>' } }),
		result: () => line({ type: 'result', subtype: 'success', session_id: sessionId, is_error: false }),
		close: () => { groupAlive = false; child.emit('close', 0, null); },
	};
}

it('writes one resumed compact only after its native ACK and observes effect through contained close', async () => {
	const f = fixture(), result = f.start(), settled = vi.fn();
	void result.then(settled, () => {});
	expect(f.lines()).toHaveLength(1);
	expect(f.spawn.mock.calls[0][1]).toEqual(expect.arrayContaining(['--resume', sessionId, '--settings', '/owned/settings.json']));
	expect(f.spawn.mock.calls[0][1]).not.toContain('--no-session-persistence');
	f.ack();
	expect(f.lines()).toHaveLength(2);
	expect(f.lines()[1]).toMatchObject({ type: 'user', uuid: inputId, session_id: sessionId, parent_tool_use_id: null,
		message: { role: 'user', content: [{ type: 'text', text: '/compact' }] } });
	f.progress(); f.init(); f.boundary(); f.summary(); f.display(); f.result();
	expect(f.child.stdin.end).toHaveBeenCalledOnce();
	await Promise.resolve();
	expect(settled).not.toHaveBeenCalled();
	f.close();
	await expect(result).resolves.toEqual({ controlId, summaryId, preTokens: 1570, postTokens: 1213,
		summaryHash: createHash('sha256').update(summary).digest('hex') });
	expect(f.lines()).toHaveLength(2);
});

it('correlates the observed effect to newly appended boundary and summary in the original native history', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'cc-compact-history-'));
	const path = join(await realpath(dir), `${sessionId}.jsonl`);
	const identity = { sessionId, cwd, version: '2.1.195', isSidechain: false };
	const original = JSON.stringify({ type: 'user', ...identity }) + '\n';
	const evidence = { controlId, summaryId, preTokens: 1570, postTokens: 1213,
		summaryHash: createHash('sha256').update(summary).digest('hex') };
	const boundary = { ...identity, type: 'system', subtype: 'compact_boundary', uuid: controlId,
		compactMetadata: { trigger: 'manual', preTokens: 1570, postTokens: 1213 } };
	const record = { ...identity, type: 'user', uuid: summaryId, isCompactSummary: true, parentUuid: controlId,
		message: { role: 'user', content: summary } };
	try {
		await writeFile(path, original, { mode: 0o600 });
		const handle = await open(path, 'r');
		try {
			const verify = () => verifyCcCompactAppend({ handle, path, original: Buffer.from(original), sessionId, cwd, version: '2.1.195', evidence });
			await expect(verify()).rejects.toThrow('durable compact effect unconfirmed');
			await appendFile(path, [boundary, { ...record, parentUuid: displayId }].map(x => JSON.stringify(x)).join('\n') + '\n');
			await expect(verify()).rejects.toThrow('durable compact effect unconfirmed');
			await writeFile(path, original + [boundary, record].map(x => JSON.stringify(x)).join('\n') + '\n');
			await expect(verify()).resolves.toBeUndefined();
		} finally { await handle.close(); }
	} finally { await rm(dir, { recursive: true, force: true }); }
});

it('never dispatches after an unrelated initialize response', async () => {
	const f = fixture(), result = f.start();
	const rejected = expect(result).rejects.toThrow('unexpected initialize response');
	f.ack('foreign'); f.close();
	await rejected;
	expect(f.lines()).toHaveLength(1);
});

it('rechecks the original control scope before writing the compact input', async () => {
	const f = fixture(), result = f.start();
	const rejected = expect(result).rejects.toThrow('original scope changed');
	f.assertCurrent.mockImplementationOnce(() => { throw new Error('revoked'); });
	f.ack(); f.close();
	await rejected;
	expect(f.lines()).toHaveLength(1);
});

it('does not treat success or an automatic boundary as the requested native effect', async () => {
	for (const send of [(f: ReturnType<typeof fixture>) => f.result(), (f: ReturnType<typeof fixture>) => f.boundary('auto')]) {
		const f = fixture(), result = f.start();
		const rejected = expect(result).rejects.toThrow('native compact effect unconfirmed');
		f.ack(); f.init(); send(f); f.close();
		await rejected;
		expect(f.lines()).toHaveLength(2);
	}
});
