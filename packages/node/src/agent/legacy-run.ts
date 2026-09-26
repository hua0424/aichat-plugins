import type { AgentDriver, AgentEvent, AgentRun, PreparedRun } from './events.js';
import type { ChatContext } from './workspace.js';
import { withLegacyNativeScope, type LegacyNativeScope } from '../capability/legacy-bridges.js';

type LegacyBinding = { aiclawUid: string; roomId: string; chatContext: ChatContext };

/** These adapters reconstruct native history from the core binding after rotation. */
export function supportsLegacyReset(driver: AgentDriver): boolean {
	return driver.type === 'cc' || driver.type === 'codex' || driver.type === 'opencode' || driver.type === 'openclaw';
}

/** Compatibility only: legacy drivers still own prompt/workspace/native-session preparation. */
export class LegacyDriverBridge {
	readonly type: string;
	readonly features: { cancel: 'best-effort'; reset: 'supported' | 'unsupported'; promptUpdate: 'new-session' };

	constructor(
		private readonly driver: AgentDriver,
		private readonly bind: (input: PreparedRun) => LegacyBinding,
		private readonly options: { cancelTimeoutMs?: number; nativeScope?: LegacyNativeScope } = {},
	) {
		this.type = driver.type;
		this.features = { cancel: 'best-effort', reset: supportsLegacyReset(driver) ? 'supported' : 'unsupported', promptUpdate: 'new-session' };
	}

	connect(): Promise<void> { return this.driver.connect(); }
	disconnect(): Promise<void> { return this.driver.disconnect(); }

	createRun(input: PreparedRun): AgentRun {
		if (!input.runId || !input.conversation || !input.signal || typeof input.message !== 'string') {
			throw new TypeError('Invalid prepared run');
		}
		const scoped = <T>(fn: () => T): T => this.options.nativeScope
			? withLegacyNativeScope(this.options.nativeScope, fn) : fn();
		const timeoutMs = this.options.cancelTimeoutMs ?? 10_000;
		if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError('Invalid cancel timeout');
		let consumed = false;
		let cancelled = input.signal.aborted;
		let submitted = false;
		let preparing = false;
		let completed = false;
		let session: Awaited<ReturnType<AgentDriver['openSession']>> | undefined;
		let closePromise: Promise<void> | undefined;
		let cancelPromise: Promise<Awaited<ReturnType<AgentRun['cancel']>>> | undefined;
		let disposed = false;
		const close = (): Promise<void> => {
			if (!session) return Promise.resolve();
			return closePromise ??= Promise.resolve().then(() => scoped(() => session!.close()));
		};
		const boundedClose = async (): Promise<void> => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					close(),
					new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
				]);
			} finally {
				if (timer) clearTimeout(timer);
			}
		};
		const onAbort = () => { void run.cancel('Aborted'); };
		input.signal.addEventListener('abort', onAbort, { once: true });
		if (input.signal.aborted) cancelled = true;

		const run: AgentRun = {
			events: {
				[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
					if (consumed) throw new Error('AgentRun events can be consumed only once');
					consumed = true;
					const iterator = execute();
					// Async generators start/resume on next(), not when constructed. Scope each
					// resume so openSession/send and their spawned event-pump tasks inherit it.
					return {
						next: () => scoped(() => iterator.next()),
						return: (value) => scoped(() => iterator.return(value)),
						throw: (error) => scoped(() => iterator.throw(error)),
					};
				},
			},
			cancel(reason: string) {
				cancelled = true;
				return cancelPromise ??= (async () => {
					if (completed || (!preparing && !submitted)) return { status: 'stopped' } as const;
					if (preparing && !submitted) return { status: 'unconfirmed', reason: 'Legacy preparation may still be running' } as const;
					try { await boundedClose(); } catch { /* close has no verified stop contract */ }
					return { status: 'unconfirmed', reason: reason || 'Legacy driver did not confirm upstream stop' } as const;
				})();
			},
			async dispose() {
				if (disposed) return;
				disposed = true;
				input.signal.removeEventListener('abort', onAbort);
				try { await boundedClose(); } catch { /* local cleanup cannot prove upstream stop */ }
			},
		};
		async function* execute(): AsyncGenerator<AgentEvent> {
			if (cancelled || disposed || input.signal.aborted) {
				yield { type: 'cancelled', reason: 'Cancelled before submission' };
				return;
			}
			try {
				const binding = bind(input);
				// Legacy openSession may perform native I/O; cancellation mid-preparation is not stop proof.
				preparing = true;
				session = await driver.openSession({ ...binding, chatContext: {
					...binding.chatContext, preparedSystemPrompt: input.systemPrompt,
					assertRunCurrent: () => input.conversation.assertCurrent(),
				} });
				preparing = false;
				if (cancelled || disposed || input.signal.aborted) {
					void boundedClose().catch(() => {}); // Only local cleanup; no input was submitted.
					yield { type: 'cancelled', reason: 'Cancelled before submission' };
					return;
				}
				// Retain only the available native locator. Legacy drivers cannot prove upstream stop
				// after restart; recovery must report unknown rather than replay or infer process death.
				await input.saveRecovery({ version: 1, value: {
					provider: driver.type, nativeState: input.conversation.nativeState ?? null,
					stopProbe: 'unsupported',
				} });
				if (cancelled || disposed || input.signal.aborted) {
					void boundedClose().catch(() => {});
					yield { type: 'cancelled', reason: 'Cancelled before submission' };
					return;
				}
				// No await between the core generation check and synchronous send(). Native drivers
				// check the same gate again after their own asynchronous pre-submit preparation.
				input.conversation.assertCurrent();
				// send() may start native work synchronously. Mark submission before calling it.
				submitted = true;
				const stream = session.send(input.message);
				let terminal: AgentEvent | undefined;
				for await (const event of stream) {
					if (terminal) continue; // Drain to real EOF; iterator.return is not stop evidence.
					if (event.type === 'done' || event.type === 'error' || event.type === 'cancelled') terminal = event;
					else yield event;
				}
				if (terminal) {
					if (cancelled && terminal.type === 'done') yield { type: 'cancelled', reason: 'Stop was not confirmed' };
					else {
						if (terminal.type === 'done') completed = true;
						yield terminal;
					}
				} else if (!cancelled) yield { type: 'error', message: 'UNEXPECTED_EOF' };
			} catch (error) {
				yield { type: 'error', message: error instanceof Error ? error.message : String(error) };
			} finally {
				input.signal.removeEventListener('abort', onAbort);
			}
		}
		const { bind, driver } = this;
		return run;
	}
}
