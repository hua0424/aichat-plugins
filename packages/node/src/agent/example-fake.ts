import { DRIVER_CONTRACT_VERSION, type DriverDescriptor } from './descriptor.js';
import type { AgentRun, PreparedRun, RunDriver } from './events.js';

/** Fifth adapter example: register this descriptor at the static assembly point to opt in. */
export const fakeDescriptor: DriverDescriptor = {
	contractVersion: DRIVER_CONTRACT_VERSION,
	type: 'fake',
	context: { kind: 'bound-channel' },
	features: { cancel: 'unsupported', reset: 'supported', promptUpdate: 'per-run' },
	create: () => new FakeDriver(),
};

class FakeDriver implements RunDriver {
	readonly type = 'fake';
	readonly features = { cancel: 'unsupported', reset: 'supported', promptUpdate: 'per-run' } as const;
	async connect(): Promise<void> {}
	async disconnect(): Promise<void> {}

	createRun(input: PreparedRun): AgentRun {
		if (!input.runId || !input.conversation || typeof input.message !== 'string')
			throw new TypeError('Invalid prepared run');
		let consumed = false;
		let submitted = false;
		let cancelled = input.signal.aborted;
		const events: AgentRun['events'] = {
			[Symbol.asyncIterator]: () => {
				if (consumed) throw new Error('AgentRun events can be consumed only once');
				consumed = true;
				return execute();
			},
		};
		async function* execute() {
			if (cancelled || input.signal.aborted) { yield { type: 'cancelled' as const, reason: 'Cancelled before submission' }; return; }
			try {
				input.conversation.assertCurrent();
				submitted = true;
				yield { type: 'thinking' as const, text: `Received: ${input.message}` };
				// This query receives the core-bound identity, not a native payload or server DTO.
				await input.capabilities.invoke('fake-query', {});
				yield { type: 'tool' as const, name: 'fake-query', phase: 'end' as const };
				yield { type: 'done' as const, durationMs: 0 };
			} catch (error) {
				yield { type: 'error' as const, message: error instanceof Error ? error.message : String(error) };
			}
		}
		return {
			events,
			async cancel(_reason) {
				if (submitted) return { status: 'unsupported' };
				cancelled = true;
				return { status: 'stopped' };
			},
			async dispose() {},
		};
	}
}
