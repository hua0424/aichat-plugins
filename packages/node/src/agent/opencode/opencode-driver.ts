import { mkdir, realpath } from 'node:fs/promises';
import type { OpencodeClient } from '@opencode-ai/sdk';
import type { AgentEvent, AgentRun, PreparedRun, RunDriver } from '../events.js';
import { mapOpencodeEvent } from './events.js';
import { AncestorChain } from './ancestor-chain.js';
import { defaultRunBindDir, removeRunBindFile, writeRunBindFile } from './run-bind.js';
import type { OpencodeServerManager } from './server-manager.js';
import { errMsg } from '../../util/err.js';

type Model = { providerID: string; modelID: string };
function parseModel(value?: string): Model | undefined {
	if (!value) return undefined;
	const slash = value.indexOf('/');
	return slash > 0 && slash < value.length - 1
		? { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) } : undefined;
}

// ponytail: conservative directory-wide claim; lift to per-session concurrency after
// pinned OpenCode runtime proves system prompts are isolated for shared directories.
const directoryOwners = new WeakMap<OpencodeServerManager, Map<string, string>>();

export interface OpencodeDriverDeps {
	server: OpencodeServerManager;
	model?: string;
	/** Core rejects another conversation's persisted claim on this physical directory. */
	assertDirectoryOwner?: (conversationId: string, directory: string) => void;
	/** Abort + status verification budget; default 10 seconds. */
	cancelTimeoutMs?: number;
	/**
	 * #405: directory holding the per-session run-bind files the serve-side `shell.env`
	 * hook reads. Defaults to `<AICHAT_HOME>/opencode/run-bind` (same host, same user).
	 */
	runBindDir?: string;
}

/** The factory owns the shared server; a driver owns only its own active turns. */
export class OpencodeDriver implements RunDriver {
	readonly type = 'opencode';
	readonly features = { cancel: 'best-effort', reset: 'supported', promptUpdate: 'per-run' } as const;
	private readonly active = new Set<OpenCodeRun>();
	constructor(private readonly deps: OpencodeDriverDeps) {
		if (deps.cancelTimeoutMs !== undefined && (!Number.isFinite(deps.cancelTimeoutMs) || deps.cancelTimeoutMs < 0))
			throw new RangeError('Invalid OpenCode cancel timeout');
	}
	async connect(): Promise<void> { await this.deps.server.ensureStarted(); }
	async disconnect(): Promise<void> {
		await Promise.all([...this.active].map((run) => run.cancel('driver disconnect')));
		// Never restart or stop the backend shared by other identities.
	}
	createRun(input: PreparedRun): AgentRun {
		if (!input.runId || !input.conversation || !input.signal || typeof input.message !== 'string' ||
			!input.workspace || typeof input.systemPrompt !== 'string' || !input.replyToken) throw new TypeError('Invalid OpenCode prepared run');
		const run = new OpenCodeRun(input, this.deps, () => this.active.delete(run));
		this.active.add(run);
		return run;
	}
}

class OpenCodeRun implements AgentRun {
	private consuming = false;
	private submitted = false;
	private completed = false;
	private cancelled = false;
	private disposed = false;
	private sessionID?: string;
	private client?: OpencodeClient;
	private stream?: AsyncIterator<unknown>;
	private cancelPromise?: Promise<Awaited<ReturnType<AgentRun['cancel']>>>;
	private wake?: () => void;
	private handshakeWake?: () => void;
	private readonly sseController = new AbortController();
	private readonly promptController = new AbortController();
	private readonly startedAt = Date.now();
	private readonly onAbort = () => { void this.cancel('aborted'); };
	constructor(private readonly input: PreparedRun, private readonly deps: OpencodeDriverDeps,
		private readonly onFinished: () => void) {}

	get events(): AsyncIterable<AgentEvent> {
		return { [Symbol.asyncIterator]: () => {
			if (this.consuming) throw new Error('OpenCode run events can be consumed only once');
			this.consuming = true;
			return this.execute();
		} };
	}

	private async *execute(): AsyncGenerator<AgentEvent> {
		const input = this.input;
		const queue: AgentEvent[] = [];
		let ended = false;
		let connected = false;
		let streamEnded = false;
		let streamFailure: string | undefined;
		// #405: per-run native ancestor ledger (user → assistant → tool call); the verdict is
		// rendered when the prompt HTTP call resolves. Spawned shells carry the exact binding
		// by file regardless; the ledger only decides what a report may CLAIM.
		const chain = new AncestorChain();
		const runBindDir = this.deps.runBindDir ?? defaultRunBindDir();
		let runBindPublished = false;
		const started = new Set<string>();
		const finished = new Set<string>();
		const assistants = new Set<string>();
		const push = (event: AgentEvent) => { if (!ended) { queue.push(event); this.wake?.(); } };
		const end = () => { ended = true; this.wake?.(); };
		const failStream = (message: string) => {
			streamFailure = message;
			// The prompt may hang indefinitely on permission/retry. Surface the native error
			// immediately; core will attempt abort and retain unconfirmed recovery.
			if (this.submitted) { push({ type: 'error', message }); end(); }
		};
		let pump: Promise<void> | undefined;
		try {
			if (this.cancelled || input.signal.aborted) { yield { type: 'cancelled', reason: 'Cancelled before submission' }; return; }
			input.signal.addEventListener('abort', this.onAbort, { once: true });
			const directory = input.workspace!;
			const previous = input.conversation.nativeState?.value;
			if (previous !== undefined && (!previous || typeof previous !== 'object' ||
				!('sessionID' in previous) || typeof previous.sessionID !== 'string' || !previous.sessionID ||
				!('directory' in previous) || previous.directory !== directory))
				throw new Error('OpenCode native session/directory mismatch; explicit reset required (history retained)');
			await mkdir(directory, { recursive: true });
			const physicalDirectory = await realpath(directory);
			const ownerKey = process.platform === 'win32' ? physicalDirectory.toLowerCase() : physicalDirectory;
			this.deps.assertDirectoryOwner?.(input.conversation.id, ownerKey);
			input.conversation.assertCurrent();
			if (this.cancelled || input.signal.aborted) { yield { type: 'cancelled', reason: 'Cancelled before submission' }; return; }
			// Until the pinned runtime proves independently scoped prompts in one directory,
			// refuse a second conversation instead of silently sharing a mutable scope.
			let owners = directoryOwners.get(this.deps.server);
			if (!owners) { owners = new Map(); directoryOwners.set(this.deps.server, owners); }
			const owner = owners.get(ownerKey);
			if (owner && owner !== input.conversation.id) throw new Error('PROMPT_SCOPE_CONFLICT: shared OpenCode directory belongs to another conversation');
			owners.set(ownerKey, input.conversation.id);
			await this.deps.server.ensureStarted();
			this.client = this.deps.server.getClient();
			if (previous && typeof previous === 'object' && 'sessionID' in previous) {
				this.sessionID = previous.sessionID as string;
			} else {
				input.conversation.assertCurrent();
				if (this.cancelled || input.signal.aborted) { yield { type: 'cancelled', reason: 'Cancelled before submission' }; return; }
				const created = await this.client.session.create({ query: { directory }, body: { title: input.conversation.id }, throwOnError: true });
				const id = created.data?.id;
				if (!id) throw new Error('OpenCode session.create returned no session id');
				this.sessionID = id;
				// A late creation after reset is not allowed to bind a stale generation.
				input.conversation.assertCurrent();
				if (this.cancelled || input.signal.aborted) { yield { type: 'cancelled', reason: 'Cancelled before submission' }; return; }
				if (!input.conversation.registerNative) throw new Error('OpenCode atomic native registration unavailable');
				await input.conversation.registerNative(id, { version: 1, value: { sessionID: id, directory } });
			}
			// Preserve the precise native locator before any prompt. Neither SSE EOF nor a rejected
			// request proves that the backend stopped or that its native history was lost.
			await input.saveRecovery({ version: 1, value: { provider: 'opencode', runId: input.runId,
				sessionID: this.sessionID, directory, stopProbe: 'unconfirmed' } });
			input.conversation.assertCurrent();
			if (this.cancelled || input.signal.aborted) { yield { type: 'cancelled', reason: 'Cancelled before submission' }; return; }
			// #405: publish this run's frozen binding for the session BEFORE any prompt, so the
			// serve-side shell.env hook resolves this sessionID → exactly this token. Publish
			// failure fails the run loudly: a turn that cannot prove its binding must never submit
			// native work whose sends would go out unassociated while claiming association.
			try {
				await writeRunBindFile(runBindDir, this.sessionID, { token: input.replyToken!,
					runId: input.runId, conversationId: input.conversation.id,
					generation: input.conversation.generation, createdAt: Date.now() });
			} catch (error) { throw new Error(`OpenCode run-bind publish failed: ${errMsg(error)}`); }
			runBindPublished = true;
			const subscribed = await this.client.event.subscribe({ query: { directory }, signal: this.sseController.signal, throwOnError: true });
			this.stream = subscribed.stream[Symbol.asyncIterator]();
			input.conversation.assertCurrent();
			if (this.cancelled || input.signal.aborted) { yield { type: 'cancelled', reason: 'Cancelled before submission' }; return; }
			const sessionID = this.sessionID!;
			const client = this.client;
			const iterator = this.stream;
			pump = (async () => {
				try {
					while (!this.cancelled && !this.disposed) {
						const next = await iterator.next();
						if (next.done) { failStream('UNEXPECTED_EOF: OpenCode SSE closed before prompt completion'); break; }
						const raw = next.value;
						if ((raw as { type?: unknown } | null)?.type === 'server.connected') {
							connected = true;
							this.handshakeWake?.();
							continue;
						}
						const assistantID = assistantMessageID(raw, sessionID);
						if (assistantID) assistants.add(assistantID);
						observeAncestor(raw, sessionID, chain);
						const ev = mapOpencodeEvent(raw, sessionID, assistants);
						if (!ev) continue;
						// session.idle is uncorrelated: a delayed idle from an earlier turn
						// must never complete this HTTP request.
						if (ev.type === 'done') continue;
						if (ev.type === 'tool') {
							const id = toolCallID(raw);
							const seen = ev.phase === 'start' ? started : finished;
							if (id && seen.has(id)) continue;
							if (id) seen.add(id);
						}
						if (ev.type === 'error') { failStream(ev.message); break; }
						push(ev);
					}
				} catch (error) { if (!this.cancelled) failStream(errMsg(error)); }
				finally { streamEnded = true; this.handshakeWake?.(); }
			})();
			// The SDK stream starts its HTTP GET only on iterator.next(). The subscribed
			// response is not a listener until server.connected reaches the pump.
			if (!connected && !streamEnded) {
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([
						new Promise<void>((resolve) => { this.handshakeWake = resolve; }),
						new Promise<void>((resolve) => { timer = setTimeout(resolve, 10_000); }),
					]);
				} finally { if (timer) clearTimeout(timer); this.handshakeWake = undefined; }
			}
			if (!connected || streamEnded) throw new Error('OpenCode SSE handshake/subscription unconfirmed; prompt not submitted');
			input.conversation.assertCurrent();
			if (this.cancelled || input.signal.aborted) { yield { type: 'cancelled', reason: 'Cancelled before submission' }; return; }
			// prompt() resolves only for THIS submitted message, unlike uncorrelated
			// session.idle. Do not await here: stream thinking while HTTP remains active.
			this.submitted = true;
			void client.session.prompt({ path: { id: sessionID }, query: { directory },
				body: { parts: [{ type: 'text', text: input.message }], system: input.systemPrompt,
					...(parseModel(this.deps.model) ? { model: parseModel(this.deps.model) } : {}) },
				signal: this.promptController.signal, throwOnError: true }).then(
				(response) => {
					if (this.cancelled) return;
					const info = response.data?.info;
					if (info?.sessionID !== sessionID || !info.id || info.error) {
						push({ type: 'error', message: info?.error
							? `OpenCode assistant error: ${JSON.stringify(info.error)}`
							: 'OpenCode prompt returned no matching assistant message' });
						return;
					}
					// #405: prove the completed assistant descends from this run's observed user
					// message. Conflict fails loudly (never current/latest guessing); missing proof
					// keeps the declared legacy-unknown posture — sends stay exactly bound by file,
					// but no report may claim a proven chain. The desensitized record persists for
					// the native verification report.
					const verdict = chain.verifyCompletion({ id: info.id, parentID: info.parentID });
					if (!verdict.ok && verdict.reason === 'conflict') {
						push({ type: 'error', message: `OpenCode ancestor conflict: ${verdict.detail} — refusing unverified association` });
						return;
					}
					const ancestor = chain.record(verdict.ok);
					if (!verdict.ok) console.error(`[opencode] run ${input.runId} ancestor unverified (${verdict.detail}); sends stay bound by session file, chain unclaimed`);
					void input.saveRecovery({ version: 1, value: { provider: 'opencode', runId: input.runId,
						sessionID, directory, stopProbe: 'unconfirmed',
						ancestorProof: verdict.ok ? 'verified' : 'unverified',
						...(!verdict.ok ? { ancestorDetail: verdict.detail } : {}), ancestor } })
						.catch((error) => console.error(`[opencode] ancestor record not persisted: ${errMsg(error)}`));
					push(streamFailure
						? { type: 'error', message: streamFailure }
						: { type: 'done', durationMs: Date.now() - this.startedAt });
				},
				(error: unknown) => { if (!this.cancelled) push({ type: 'error', message: errMsg(error) }); },
			).finally(end);
			while (!ended || queue.length) {
				if (this.cancelled) { yield { type: 'cancelled', reason: 'OpenCode stop not confirmed' }; return; }
				if (queue.length) {
					const ev = queue.shift()!;
					if (ev.type === 'done') this.completed = true;
					yield ev;
					if (ev.type === 'done' || ev.type === 'error') return;
				} else await new Promise<void>((resolve) => { this.wake = resolve; });
			}
			if (!this.cancelled) yield { type: 'error', message: 'UNEXPECTED_EOF' };
		} catch (error) {
			yield this.cancelled ? { type: 'cancelled', reason: 'OpenCode stop not confirmed' }
				: { type: 'error', message: errMsg(error) };
		} finally {
			input.signal.removeEventListener('abort', this.onAbort);
			this.disposed = true;
			this.sseController.abort();
			this.promptController.abort();
			// #405: withdraw this session's file binding best-effort. Already-spawned shells
			// keep their frozen env (a valid old binding still routes to A per core rules); new
			// shells fall back to fail-closed empty. Guarded by runId so a next run's file is
			// never removed.
			if (runBindPublished && this.sessionID) await removeRunBindFile(runBindDir, this.sessionID, input.runId);
			void this.stream?.return?.().catch(() => {});
			void pump?.catch(() => {});
			this.onFinished();
		}
	}

	async cancel(reason: string): Promise<Awaited<ReturnType<AgentRun['cancel']>>> {
		if (this.completed) return { status: 'stopped' };
		this.cancelled = true;
		this.sseController.abort(); // local subscription only; never proof of native stop
		this.promptController.abort(); // local HTTP request only; native abort is separate
		this.wake?.();
		this.handshakeWake?.();
		if (!this.submitted) return { status: 'stopped' };
		return this.cancelPromise ??= this.abortAndVerify(reason);
	}

	private async abortAndVerify(reason: string): Promise<Awaited<ReturnType<AgentRun['cancel']>>> {
		const client = this.client!;
		const id = this.sessionID!;
		const directory = this.input.workspace!;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				(async () => {
					const result = await client.session.abort({ path: { id }, query: { directory }, throwOnError: true });
					if (result.data !== true) return { status: 'unconfirmed', reason: `${reason}: OpenCode abort not acknowledged` } as const;
					const status = await client.session.status({ query: { directory }, throwOnError: true });
					// A status snapshot can precede acceptance of the in-flight promptAsync POST.
					// Until the pinned server verifies ordering, even abort + idle is not stop proof.
					return { status: 'unconfirmed', reason: `${reason}: OpenCode abort acknowledged, status=${status.data?.[id]?.type ?? 'unknown'}; submitted turn stop not verified` } as const;
				})(),
				new Promise<{ status: 'unconfirmed'; reason: string }>((resolve) => {
					timer = setTimeout(() => resolve({ status: 'unconfirmed', reason: `${reason}: OpenCode abort/status timed out` }),
						this.deps.cancelTimeoutMs ?? 10_000);
				}),
			]);
		} catch (error) { return { status: 'unconfirmed', reason: `${reason}: ${errMsg(error)}` }; }
		finally { if (timer) clearTimeout(timer); }
	}
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.sseController.abort();
		this.promptController.abort();
		// Subscription cleanup alone is NOT upstream cancellation or stop proof.
		if (!this.completed) await this.cancel('dispose');
		void this.stream?.return?.().catch(() => {});
		this.wake?.();
	}
}

function toolCallID(raw: unknown): string | undefined {
	const part = (raw as { properties?: { part?: { callID?: unknown } } } | null)?.properties?.part;
	return typeof part?.callID === 'string' ? part.callID : undefined;
}
/**
 * #405: feed raw SSE frames into the per-run ancestor ledger. Session-scoped (the
 * subscription is shared per directory); stale pre-run replays are filtered by the
 * ledger's start time, never by "current run" guessing.
 */
function observeAncestor(raw: unknown, sessionID: string, chain: AncestorChain): void {
	const ev = raw as { type?: unknown; properties?: { info?: unknown; part?: unknown } } | null;
	const props = ev !== null && typeof ev === 'object' ? ev.properties : undefined;
	if (!props || typeof props !== 'object') return;
	if (ev?.type === 'message.updated' && props.info !== null && typeof props.info === 'object') {
		const info = props.info as { id?: unknown; role?: unknown; parentID?: unknown; sessionID?: unknown; time?: unknown };
		if (info.sessionID !== sessionID) return;
		const time = info.time !== null && typeof info.time === 'object'
			? (info.time as { created?: unknown }).created : undefined;
		chain.observeMessageUpdated({ id: info.id, role: info.role, parentID: info.parentID, timeCreated: time });
	} else if (ev?.type === 'message.part.updated' && props.part !== null && typeof props.part === 'object') {
		const part = props.part as { type?: unknown; sessionID?: unknown; messageID?: unknown; callID?: unknown };
		if (part.type !== 'tool' || part.sessionID !== sessionID) return;
		chain.observeToolPart({ callID: part.callID, messageID: part.messageID });
	}
}
function assistantMessageID(raw: unknown, sessionID: string): string | undefined {
	const ev = raw as { type?: unknown; properties?: { info?: { id?: unknown; sessionID?: unknown; role?: unknown } } } | null;
	const info = ev?.properties?.info;
	return ev?.type === 'message.updated' && info?.sessionID === sessionID && info.role === 'assistant' &&
		typeof info.id === 'string' ? info.id : undefined;
}
