import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Thread, ThreadOptions, TurnOptions } from '@openai/codex-sdk';
import { CodexDriver, type CodexClient } from './codex-driver.js';
import type { AgentEvent, PreparedRun } from '../events.js';

function fixture(state?: unknown) {
	const workspace = mkdtempSync(join(tmpdir(), 'codex-native-'));
	let nativeState = state;
	const saveNativeState = vi.fn(async (v: { value: unknown }) => { nativeState = v.value; });
	const registerNative = vi.fn(async (_id: string, v: { value: unknown }) => { nativeState = v.value; });
	const registerNativeAlias = vi.fn(async () => {});
	const saveRecovery = vi.fn(async () => {});
	const input: PreparedRun = {
		runId: 'run-1', message: 'original user text', workspace, systemPrompt: 'persona 1',
		conversation: { id: 'c1', generation: 1, get nativeState() { return nativeState === undefined ? undefined : { version: 1, value: nativeState }; },
			assertCurrent() {}, saveNativeState, registerNativeAlias, registerNative },
		saveRecovery, capabilities: { async invoke() {} }, signal: new AbortController().signal,
	};
	return { workspace, input, saveNativeState, registerNativeAlias, registerNative, saveRecovery,
		get state() { return nativeState; }, cleanup: () => rmSync(workspace, { recursive: true, force: true }) };
}
function sdk() {
	let signal: AbortSignal | undefined;
	let threadId = 'thread-1';
	let release!: () => void;
	const parked = new Promise<void>((r) => { release = r; });
	const events = async function* () {
		yield { type: 'thread.started', thread_id: threadId };
		yield { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'thinking' } };
		yield { type: 'turn.completed', usage: {} };
	};
	const runStreamed = vi.fn(async (_text: string, opts?: TurnOptions) => { signal = opts?.signal; return { events: events() }; });
	const thread = { runStreamed } as unknown as Thread;
	const startThread = vi.fn((_opts?: ThreadOptions) => thread);
	const resumeThread = vi.fn((id: string, _opts?: ThreadOptions) => { threadId = id; return thread; });
	const createCodex = vi.fn((_prompt: string): CodexClient => ({ startThread, resumeThread }));
	return { createCodex, startThread, resumeThread, runStreamed, get signal() { return signal; }, parked, release };
}
async function collect(events: AsyncIterable<AgentEvent>) { const result: AgentEvent[] = []; for await (const e of events) result.push(e); return result; }

describe('Codex native AgentRun', () => {
	it('registers core state and alias, preserves pure user text and does not write AGENTS.md', async () => {
		const f = fixture(); const s = sdk();
		try {
			const driver = new CodexDriver({ createCodex: s.createCodex });
			const result = await collect(driver.createRun(f.input).events);
			expect(s.createCodex).toHaveBeenCalledWith('persona 1');
			expect(s.startThread).toHaveBeenCalledWith(expect.objectContaining({ workingDirectory: f.workspace }));
			expect(s.runStreamed).toHaveBeenCalledWith('original user text', { signal: expect.any(AbortSignal) });
			expect(f.state).toEqual({ threadId: 'thread-1', promptHash: expect.any(String), workspace: f.workspace });
			expect(f.registerNative).toHaveBeenCalledWith('thread-1', { version: 1, value: f.state });
			expect(f.saveRecovery).toHaveBeenCalledTimes(2);
			expect(existsSync(join(f.workspace, 'AGENTS.md'))).toBe(false);
			expect(result).toEqual([{ type: 'thinking', text: 'thinking' }, { type: 'done', durationMs: expect.any(Number) }]);
		} finally { f.cleanup(); }
	});
	it('keeps imported legacy threadId but blocks unsafe resume until original cwd/persona are verified', async () => {
		const f = fixture({ threadId: 'legacy-thread' }); const s = sdk();
		try {
			expect(await collect(new CodexDriver({ createCodex: s.createCodex }).createRun(f.input).events))
				.toEqual([{ type: 'error', message: expect.stringContaining('CODEX_LEGACY_THREAD_UNVERIFIED') }]);
			expect(s.resumeThread).not.toHaveBeenCalled();
			expect(s.startThread).not.toHaveBeenCalled();
			expect(f.state).toEqual({ threadId: 'legacy-thread' });
		} finally { f.cleanup(); }
	});
	it('resumes the exact owner-confirmed legacy ID and original frozen prompt, deferring new persona', async () => {
		const f = fixture(); const s = sdk();
		try {
			const originalPrompt = 'historical persona';
			const state = { threadId: 'old-thread', workspace: f.workspace, originalPrompt,
				promptHash: createHash('sha256').update(originalPrompt).digest('hex'), legacyConfirmationRequired: false };
			await f.input.conversation.saveNativeState({ version: 1, value: state });
			f.input.systemPrompt = 'new persona after migration';
			const events = await collect(new CodexDriver({ createCodex: s.createCodex }).createRun(f.input).events);
			expect(events.at(-1)?.type).toBe('done');
			expect(s.resumeThread).toHaveBeenCalledWith('old-thread', expect.objectContaining({ workingDirectory: f.workspace }));
			expect(s.createCodex).toHaveBeenCalledWith(originalPrompt);
			expect(f.state).toEqual(state);
			expect(s.startThread).not.toHaveBeenCalled();
		} finally { f.cleanup(); }
	});
	it('rejects changed persona on existing native thread without deleting history or submitting', async () => {
		const f = fixture(); const s = sdk();
		try {
			await collect(new CodexDriver({ createCodex: s.createCodex }).createRun(f.input).events);
			f.input.systemPrompt = 'persona 2';
			expect(await collect(new CodexDriver({ createCodex: s.createCodex }).createRun(f.input).events))
				.toEqual([{ type: 'error', message: expect.stringContaining('explicit reset required') }]);
			expect(s.createCodex).toHaveBeenCalledTimes(1);
		} finally { f.cleanup(); }
	});
	it('does not self-heal a dead resumed thread or erase its native state', async () => {
		const f = fixture(); const s = sdk();
		try {
			await collect(new CodexDriver({ createCodex: s.createCodex }).createRun(f.input).events);
			const state = f.state;
			s.runStreamed.mockRejectedValueOnce(new Error('thread/resume failed: no rollout found (-32600)'));
			expect(await collect(new CodexDriver({ createCodex: s.createCodex }).createRun(f.input).events))
				.toEqual([{ type: 'error', message: expect.stringContaining('no rollout found') }]);
			expect(s.startThread).toHaveBeenCalledTimes(1); // initial run only; no fallback
			expect(s.resumeThread).toHaveBeenCalledWith('thread-1', expect.anything());
			expect(f.state).toEqual(state);
		} finally { f.cleanup(); }
	});
	it('does not publish done before SDK stream reaches native exit', async () => {
		const f = fixture(); const s = sdk();
		try {
			let release!: () => void;
			const exited = new Promise<void>((resolve) => { release = resolve; });
			s.runStreamed.mockImplementationOnce(async () => ({ events: (async function* () {
				yield { type: 'thread.started', thread_id: 'thread-1' };
				yield { type: 'turn.completed', usage: {} };
				await exited;
			})() }));
			const iter = new CodexDriver({ createCodex: s.createCodex }).createRun(f.input).events[Symbol.asyncIterator]();
			let resolved = false;
			const next = iter.next().then((value) => { resolved = true; return value; });
			await vi.waitFor(() => expect(s.runStreamed).toHaveBeenCalledOnce());
			await new Promise((r) => setImmediate(r));
			expect(resolved).toBe(false);
			release();
			expect((await next).value?.type).toBe('done');
		} finally { f.cleanup(); }
	});
	it('does not complete a fresh turn without an atomically registered native ID', async () => {
		const f = fixture(); const s = sdk();
		try {
			s.runStreamed.mockImplementationOnce(async () => ({ events: (async function* () {
				yield { type: 'turn.completed', usage: {} };
			})() }));
			const run = new CodexDriver({ createCodex: s.createCodex }).createRun(f.input);
			expect(await collect(run.events)).toEqual([{ type: 'error', message: expect.stringContaining('without a registered native thread ID') }]);
			expect(f.registerNative).not.toHaveBeenCalled();
			expect(await run.cancel('handler error')).toEqual({ status: 'stopped' });
		} finally { f.cleanup(); }
	});
	it('terminal turn.failed followed by SDK native EOF is a confirmed stop', async () => {
		const f = fixture(); const s = sdk();
		try {
			s.runStreamed.mockImplementationOnce(async () => ({ events: (async function* () {
				yield { type: 'turn.failed', error: { message: 'upstream error' } };
			})() }));
			const run = new CodexDriver({ createCodex: s.createCodex }).createRun(f.input);
			expect(await collect(run.events)).toEqual([{ type: 'error', message: 'upstream error' }]);
			expect(await run.cancel('handler error')).toEqual({ status: 'stopped' });
		} finally { f.cleanup(); }
	});
	it('pre-submit cancellation is stopped without SDK execution', async () => {
		const f = fixture(); const s = sdk();
		try {
			const run = new CodexDriver({ createCodex: s.createCodex }).createRun(f.input);
			expect(await run.cancel('test')).toEqual({ status: 'stopped' });
			expect(await collect(run.events)).toEqual([{ type: 'cancelled', reason: 'Cancelled before submission' }]);
			expect(s.createCodex).not.toHaveBeenCalled();
		} finally { f.cleanup(); }
	});
	it('abort reaches SDK signal, but cancellation remains unconfirmed without process exit evidence', async () => {
		const f = fixture(); const s = sdk();
		try {
			s.runStreamed.mockImplementationOnce(async (_text: string, opts?: TurnOptions) => {
				const signal = opts?.signal;
				return { events: (async function* () {
					await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
					throw new Error('AbortError');
				})() };
			});
			const run = new CodexDriver({ createCodex: s.createCodex }).createRun(f.input);
			const result = collect(run.events);
			await vi.waitFor(() => expect(s.runStreamed).toHaveBeenCalledOnce());
			expect(await run.cancel('test')).toEqual({ status: 'unconfirmed', reason: expect.stringContaining('not verified') });
			expect(s.runStreamed.mock.calls[0][1]?.signal?.aborted).toBe(true);
			expect(await result).toEqual([{ type: 'cancelled', reason: 'Codex process stop unconfirmed' }]);
		} finally { f.cleanup(); }
	});
	it('rejects changed workspace on existing thread without native execution', async () => {
		const f = fixture({ threadId: 't', workspace: 'old-workspace' }); const s = sdk();
		try {
			expect(await collect(new CodexDriver({ createCodex: s.createCodex }).createRun(f.input).events))
				.toEqual([{ type: 'error', message: expect.stringContaining('explicit reset required') }]);
			expect(s.createCodex).not.toHaveBeenCalled();
		} finally { f.cleanup(); }
	});
	it('rejects conflicting legacy AGENTS.md without modifying the owner file', async () => {
		const f = fixture(); const s = sdk();
		const old = '<!-- aichat:system:begin -->\nold persona\n<!-- aichat:system:end -->\n';
		try {
			writeFileSync(join(f.workspace, 'AGENTS.md'), old);
			expect(await collect(new CodexDriver({ createCodex: s.createCodex }).createRun(f.input).events))
				.toEqual([{ type: 'error', message: expect.stringContaining('PROMPT_SCOPE_CONFLICT') }]);
			expect(s.createCodex).not.toHaveBeenCalled();
			expect(existsSync(join(f.workspace, 'AGENTS.md'))).toBe(true);
		} finally { f.cleanup(); }
	});
	it('rejects an inherited managed AGENTS.md block from a workspace ancestor', async () => {
		const f = fixture(); const s = sdk();
		try {
			writeFileSync(join(f.workspace, 'AGENTS.md'), '<!-- aichat:system:begin -->\nother identity\n<!-- aichat:system:end -->\n');
			f.input.workspace = join(f.workspace, 'nested');
			expect(await collect(new CodexDriver({ createCodex: s.createCodex }).createRun(f.input).events))
				.toEqual([{ type: 'error', message: expect.stringContaining('PROMPT_SCOPE_CONFLICT') }]);
			expect(s.createCodex).not.toHaveBeenCalled();
		} finally { f.cleanup(); }
	});
	it.each(['<!-- aichat:system:begin -->\npersona 1\n<!-- aichat:system:end -->\n<!-- aichat:system:end -->',
		'<!-- aichat:system:begin -->\npersona 1\n<!-- aichat:system:end -->\n<!-- aichat:system:begin -->'])
	('rejects extra or orphan managed marker while leaving file intact', async (text) => {
		const f = fixture(); const s = sdk();
		try {
			writeFileSync(join(f.workspace, 'AGENTS.md'), text);
			expect(await collect(new CodexDriver({ createCodex: s.createCodex }).createRun(f.input).events))
				.toEqual([{ type: 'error', message: expect.stringContaining('PROMPT_SCOPE_CONFLICT') }]);
			expect(s.createCodex).not.toHaveBeenCalled();
		} finally { f.cleanup(); }
	});
	it('two identities in same workspace get separate per-run client configuration', async () => {
		const f = fixture(); const s = sdk();
		try {
			const other = fixture(); other.input.workspace = f.workspace; other.input.systemPrompt = 'persona 2';
			await Promise.all([collect(new CodexDriver({ createCodex: s.createCodex }).createRun(f.input).events),
				collect(new CodexDriver({ createCodex: s.createCodex }).createRun(other.input).events)]);
			expect(s.createCodex.mock.calls.map(([prompt]) => prompt).sort()).toEqual(['persona 1', 'persona 2']);
			expect(existsSync(join(f.workspace, 'AGENTS.md'))).toBe(false);
			other.cleanup();
		} finally { f.cleanup(); }
	});
});
