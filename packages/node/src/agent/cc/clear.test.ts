import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { observeCcClear, verifyCcClearHistory } from './clear.js';
import type { CcSpawnFn } from './headless-driver.js';

const oldId = '14972303-2a4e-49b1-8726-708b7f2c78a4';
const newId = 'a4b791fa-568f-479b-a65d-12f7a2eb5f55';
const inputId = '94f1a809-4687-4f8f-8a80-0dc54fd7276c';
const cwd = process.cwd();

function fixture(beforeInput = async () => {}) {
	const child = Object.assign(new EventEmitter(), {
		pid: 4242, stdin: { writable: true, write: vi.fn<(frame: string) => void>(), end: vi.fn() },
		stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(() => true),
	});
	const spawn = vi.fn<CcSpawnFn>(() => child);
	let gone = false;
	const kill = vi.fn((pid: number, signal?: NodeJS.Signals | number) => {
		if (pid === -child.pid && signal === 0 && gone) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
	});
	const onSubmit = vi.fn();
	const result = observeCcClear({ cwd, sessionId: oldId, inputId, claudeBin: '/owned/claude', settingsPath: '/owned/settings.json',
		env: { HOME: '/owned/home' }, signal: new AbortController().signal, beforeInput, onSubmit, spawn, kill, platform: 'linux' });
	const frames = () => child.stdin.write.mock.calls.map(([raw]) => JSON.parse(raw));
	const line = (frame: object) => child.stdout.emit('data', `${JSON.stringify(frame)}\n`);
	const usage = { input_tokens: 0, output_tokens: 0 };
	return { result, child, spawn, frames, onSubmit,
		ack: () => line({ type: 'control_response', response: { subtype: 'success', request_id: frames()[0].request_id } }),
		init: (id = newId) => line({ type: 'system', subtype: 'init', session_id: id, cwd, claude_code_version: '2.1.195',
			permissionMode: 'default', tools: [], mcp_servers: [] }),
		display: () => line({ type: 'assistant', session_id: newId, uuid: outputId, parent_tool_use_id: null,
			message: { role: 'assistant', model: '<synthetic>', usage, content: [{ type: 'text', text: '(no content)' }] } }),
		terminal: (id = newId, reply = '') => line({ type: 'result', subtype: 'success', session_id: id, is_error: false,
			num_turns: 0, result: reply, usage, permission_denials: [], duration_api_ms: 20325, modelUsage: { earlier: { inputTokens: 821 } } }),
		close: () => { gone = true; child.emit('close', 0, null); },
	};
}

it('observes one exact native Clear switch without submitting an ordinary prompt or claiming a durable binding', async () => {
	const f = fixture(), settled = vi.fn();
	void f.result.then(settled, () => {});
	expect(f.spawn.mock.calls[0][1]).toEqual(expect.arrayContaining(['--resume', oldId, '--safe-mode', '--tools', '']));
	expect(f.frames()).toHaveLength(1);
	f.ack();
	await Promise.resolve();
	expect(f.onSubmit).toHaveBeenCalledOnce();
	expect(f.frames()).toHaveLength(2);
	expect(f.frames()[1]).toMatchObject({ type: 'user', uuid: inputId, session_id: oldId, parent_tool_use_id: null,
		message: { role: 'user', content: [{ type: 'text', text: '/clear' }] } });
	f.init(); f.display(); f.terminal();
	await Promise.resolve();
	expect(settled).not.toHaveBeenCalled();
	f.close();
	await expect(f.result).resolves.toEqual({ observedSessionId: newId, outputId });
	expect(f.frames()).toHaveLength(2);
});

it.each(['old session', 'missing init', 'ordinary output'])('rejects %s as Clear effect evidence', async (kind) => {
	const f = fixture();
	const failure = expect(f.result).rejects.toThrow('native clear transition unconfirmed');
	f.ack();
	await Promise.resolve();
	if (kind === 'old session') { f.init(oldId); f.terminal(oldId); }
	else if (kind === 'missing init') f.terminal();
	else { f.init(); f.display(); f.terminal(newId, 'provider output'); }
	f.close();
	await failure;
	expect(f.frames()).toHaveLength(2);
});

it('does not mark a submission if the frozen history check fails or stdin closes', async () => {
	let authorize!: () => void;
	const check = new Promise<void>((resolve) => { authorize = resolve; });
	const f = fixture(() => check);
	const failure = expect(f.result).rejects.toThrow('input closed');
	f.ack();
	f.child.stdin.writable = false;
	authorize();
	await Promise.resolve();
	f.close();
	await failure;
	expect(f.onSubmit).not.toHaveBeenCalled();
	expect(f.frames()).toHaveLength(1);
});

const caveatId = '45c07ac5-895d-4ef8-88b4-a199a851ef5e';
const commandId = 'f7bc725c-74d0-46b7-a9cf-76050b7e4dc7';
const outputId = 'be31980c-10ab-48f4-98b5-1ce2a2a2c957';
const encode = (...rows: object[]) => Buffer.from(rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
const prior = encode({ type: 'user', sessionId: oldId, message: { role: 'user', content: 'old conversation content' } });
const nativeScope = { cwd, sessionId: newId, version: '2.1.195', isSidechain: false };
const fresh = [
	{ ...nativeScope, type: 'user', uuid: caveatId, parentUuid: null, isMeta: true,
		message: { role: 'user', content: '<local-command-caveat>Native caveat only.</local-command-caveat>' } },
	{ ...nativeScope, type: 'user', uuid: commandId, parentUuid: caveatId, message: { role: 'user',
		content: '<command-name>/clear</command-name>\n  <command-message>clear</command-message>\n  <command-args></command-args>' } },
	{ ...nativeScope, type: 'system', uuid: outputId, parentUuid: commandId, subtype: 'local_command', level: 'info', isMeta: false,
		content: '<local-command-stdout></local-command-stdout>' },
];

it('requires the old history prefix and a fresh command-only native branch, not a fabricated empty file', () => {
	const verify = (original: Buffer, next: Buffer) => verifyCcClearHistory({ cwd, oldSessionId: oldId, newSessionId: newId,
		oldBefore: prior, oldAfter: original, newHistory: next, outputId });
	const oldAfter = Buffer.concat([prior, encode({ type: 'mode', mode: 'normal', sessionId: oldId },
		{ type: 'queue-operation', operation: 'enqueue', content: '/clear', sessionId: oldId },
		{ type: 'queue-operation', operation: 'dequeue', sessionId: oldId })]);
	const mode = { type: 'mode', mode: 'normal', sessionId: newId };
	expect(verify(oldAfter, encode(mode, ...fresh))).toBe(true);
	const leaf = { type: 'last-prompt', leafUuid: outputId, sessionId: newId };
	expect(verify(oldAfter, encode(mode, ...fresh, leaf))).toBe(true);
	expect(verify(oldAfter, encode(mode, ...fresh, { ...leaf, lastPrompt: 'old prompt' }))).toBe(false);
	expect(verify(oldAfter, encode(mode, ...fresh, { ...leaf, leafUuid: commandId }))).toBe(false);
	expect(verify(oldAfter, encode(mode))).toBe(false);
	expect(verify(oldAfter, encode(...fresh, { ...nativeScope, type: 'assistant' }))).toBe(false);
	expect(verify(oldAfter, encode(...fresh.slice(0, 2), { ...fresh[2], parentUuid: caveatId }))).toBe(false);
	expect(verify(encode({ type: 'user', sessionId: oldId }), encode(...fresh))).toBe(false);
	expect(verify(Buffer.concat([prior, encode({ type: 'user', sessionId: oldId })]), encode(...fresh))).toBe(false);
});
