import { mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AICHAT_SYSTEM_BEGIN, AICHAT_SYSTEM_END, renderSystemBlock } from '../agents-md.js';
import { createHash } from 'node:crypto';
import type { Codex, Thread, ThreadOptions } from '@openai/codex-sdk';
import type { AgentEvent, AgentRun, PreparedRun, RunDriver } from '../events.js';
import { mapCodexEvent } from './events.js';
import { errMsg } from '../../util/err.js';

export interface CodexClient {
	startThread(opts?: ThreadOptions): Thread;
	resumeThread(id: string, opts?: ThreadOptions): Thread;
}
export type _CodexSatisfiesClient = Codex extends CodexClient ? true : never;
export interface CodexDriverDeps {
	/** A fresh client per run: CLI developer_instructions are client-scoped, not thread-scoped. */
	createCodex: (systemPrompt: string) => CodexClient;
	model?: string;
}

/** Native thread binding, recovery, and CODEX_THREAD_ID alias are owned by core. */
export class CodexDriver implements RunDriver {
	readonly type = 'codex';
	readonly features = { cancel: 'best-effort', reset: 'supported', promptUpdate: 'new-session' } as const;
	private readonly active = new Set<CodexRun>();
	constructor(private readonly deps: CodexDriverDeps) {}
	async connect(): Promise<void> {}
	async disconnect(): Promise<void> {
		await Promise.all([...this.active].map((run) => run.cancel('driver disconnect')));
	}
	createRun(input: PreparedRun): AgentRun {
		if (!input.runId || !input.conversation || !input.signal || typeof input.message !== 'string' ||
			!input.workspace || typeof input.systemPrompt !== 'string') throw new TypeError('Invalid Codex prepared run');
		const run = new CodexRun(input, this.deps, () => this.active.delete(run));
		this.active.add(run);
		return run;
	}
}

class CodexRun implements AgentRun {
	private readonly controller = new AbortController();
	private consuming = false;
	private submitted = false;
	private finished = false;
	private nativeExited = false;
	private cancelled = false;
	private readonly startedAt = Date.now();
	private readonly onAbort = () => { void this.cancel('aborted'); };
	constructor(private readonly input: PreparedRun, private readonly deps: CodexDriverDeps,
		private readonly onFinished: () => void) {}

	get events(): AsyncIterable<AgentEvent> {
		return { [Symbol.asyncIterator]: () => {
			if (this.consuming) throw new Error('Codex run events can be consumed only once');
			this.consuming = true;
			return this.execute();
		} };
	}

	private async *execute(): AsyncGenerator<AgentEvent> {
		const input = this.input;
		const previous = input.conversation.nativeState?.value;
		const frozenPrompt = previous && typeof previous === 'object' && 'originalPrompt' in previous
			? previous.originalPrompt : undefined;
		const systemPrompt = typeof frozenPrompt === 'string' ? frozenPrompt : input.systemPrompt;
		const digest = createHash('sha256').update(systemPrompt).digest('hex');
		const toolStarted = new Set<string>();
		const toolEnded = new Set<string>();
		try {
			if (this.cancelled || input.signal.aborted) { yield { type: 'cancelled', reason: 'Cancelled before submission' }; return; }
			input.signal.addEventListener('abort', this.onAbort, { once: true });
			if (previous !== undefined && (!previous || typeof previous !== 'object' ||
				!('threadId' in previous) || typeof previous.threadId !== 'string' || !previous.threadId ||
				('workspace' in previous && previous.workspace !== input.workspace) ||
				('promptHash' in previous && previous.promptHash !== digest) ||
				('originalPrompt' in previous && (typeof previous.originalPrompt !== 'string' ||
					(!('legacyConfirmationRequired' in previous) || previous.legacyConfirmationRequired !== false)))))
				throw new Error('Codex native thread invalid or original cwd/prompt mismatch; explicit reset required (history retained)');
			if (previous && typeof previous === 'object' &&
				(!('workspace' in previous) || !('promptHash' in previous)))
				throw new Error('CODEX_LEGACY_THREAD_UNVERIFIED: original cwd/persona unknown; owner must verify provenance before resume or explicitly reset');
			if (frozenPrompt !== undefined && input.systemPrompt !== systemPrompt)
				console.warn('[codex] updated persona deferred for confirmed legacy thread until explicit reset');
			const threadId = previous && typeof previous === 'object' && 'threadId' in previous ? previous.threadId as string : undefined;
			await mkdir(input.workspace!, { recursive: true });
			// Codex also loads AGENTS.md from ancestor directories, not just the working directory.
			// The owner may reconcile only an explicitly approved block; never edit any of these files here.
			const physical = await realpath(input.workspace!);
			for (let dir = physical; ; dir = dirname(dir)) {
				let agents = '';
				try { agents = await readFile(join(dir, 'AGENTS.md'), 'utf8'); }
				catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
				const begins = agents.split(AICHAT_SYSTEM_BEGIN).length - 1;
				const ends = agents.split(AICHAT_SYSTEM_END).length - 1;
				if ((begins || ends) && (dir !== physical || begins !== 1 || ends !== 1 ||
					!agents.includes(renderSystemBlock(systemPrompt))))
					throw new Error('PROMPT_SCOPE_CONFLICT: managed AGENTS.md in workspace or ancestor is unverified');
				if (dir === dirname(dir)) break;
			}
			input.conversation.assertCurrent();
			if (this.cancelled || input.signal.aborted) { yield { type: 'cancelled', reason: 'Cancelled before submission' }; return; }
			const opts: ThreadOptions = { sandboxMode: 'danger-full-access', approvalPolicy: 'never',
				skipGitRepoCheck: true, workingDirectory: input.workspace, ...(this.deps.model ? { model: this.deps.model } : {}) };
			const codex = this.deps.createCodex(systemPrompt);
			const thread = threadId ? codex.resumeThread(threadId, opts) : codex.startThread(opts);
			// Recovery is recorded before the SDK starts codex exec; a crash/abort cannot silently
			// re-submit this turn. An SDK AbortSignal kills its direct child, not a verified process group.
			await input.saveRecovery({ version: 1, value: { provider: 'codex', runId: input.runId,
				threadId: threadId ?? null, workspace: input.workspace, stopProbe: 'unknown-after-restart' } });
			input.conversation.assertCurrent();
			if (this.cancelled || input.signal.aborted) { yield { type: 'cancelled', reason: 'Cancelled before submission' }; return; }
			this.submitted = true;
			const { events } = await thread.runStreamed(input.message, { signal: this.controller.signal });
			let terminal: AgentEvent | undefined;
			let registered = threadId !== undefined; // a resumed run already has an atomic native binding
			for await (const raw of events) {
				if (this.cancelled) break;
				if (terminal) continue; // wait for native subprocess EOF before reporting terminal status
				if (raw.type === 'thread.started' && threadId && raw.thread_id !== threadId)
					throw new Error('Codex resumed thread changed identity; explicit recovery required');
				if (raw.type === 'thread.started') {
					const id = raw.thread_id;
					if (!id) throw new Error('Codex thread.started missing thread id');
					if (!input.conversation.registerNative) throw new Error('Codex atomic native registration unavailable');
					await input.conversation.registerNative(id, { version: 1, value: {
						...(frozenPrompt !== undefined ? { originalPrompt: systemPrompt, legacyConfirmationRequired: false } : {}),
						threadId: id, promptHash: digest, workspace: input.workspace,
					} });
					await input.saveRecovery({ version: 1, value: { provider: 'codex', runId: input.runId,
						threadId: id, workspace: input.workspace, stopProbe: 'unknown-after-restart' } });
					registered = true;
					continue;
				}
				const ev = mapCodexEvent(raw);
				if (!ev) continue;
				if (ev.type === 'tool') {
					const itemId = 'item' in raw && raw.item && typeof raw.item === 'object' && 'id' in raw.item ? raw.item.id : undefined;
					if (typeof itemId === 'string') {
						const seen = ev.phase === 'start' ? toolStarted : toolEnded;
						if (seen.has(itemId)) continue;
						seen.add(itemId);
					}
				}
				if (ev.type === 'done' || ev.type === 'error') { terminal = ev; continue; }
				yield ev;
			}
			if (!this.cancelled) this.nativeExited = true; // SDK normal EOF awaited child exitPromise
			if (this.cancelled) yield { type: 'cancelled', reason: 'Codex process stop unconfirmed' };
			else if (terminal?.type === 'done' && !registered)
				yield { type: 'error', message: 'Codex completed without a registered native thread ID' };
			else if (terminal?.type === 'done') yield { type: 'done', durationMs: Date.now() - this.startedAt };
			else yield terminal ?? { type: 'error', message: 'Codex stream ended without terminal event' };
		} catch (error) {
			yield this.cancelled ? { type: 'cancelled', reason: 'Codex process stop unconfirmed' }
				: { type: 'error', message: errMsg(error) };
		} finally {
			input.signal.removeEventListener('abort', this.onAbort);
			this.finished = true;
			if (!this.cancelled || !this.submitted) this.onFinished();
		}
	}

	async cancel(reason: string): Promise<Awaited<ReturnType<AgentRun['cancel']>>> {
		if (this.nativeExited) {
			this.onFinished();
			return { status: 'stopped' };
		}
		this.cancelled = true;
		this.controller.abort();
		if (!this.submitted) {
			if (!this.consuming) this.onFinished();
			return { status: 'stopped' };
		}
		// SDK 0.142.3 forwards signal to spawn(), but does not expose child exit or process-group
		// verification. iterator.return() only closes the JSONL reader, not the native process.
		return { status: 'unconfirmed', reason: `${reason}: SDK subprocess/process-group exit not verified` };
	}
	async dispose(): Promise<void> {
		if (!this.finished) await this.cancel('dispose');
	}
}
