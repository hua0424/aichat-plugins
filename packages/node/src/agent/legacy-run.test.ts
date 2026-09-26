import { describe, expect, it, vi } from 'vitest';
import { LegacyDriverBridge } from './legacy-run.js';
import type { AgentDriver, AgentEvent, AgentSession, PreparedRun } from './events.js';

function fixture() {
	const controller = new AbortController();
	const input: PreparedRun = {
		runId: 'run-1', message: '[HuLa 群聊]\n[alice]: hi', systemPrompt: '', signal: controller.signal,
		conversation: {
			id: 'conversation-1', generation: 1, nativeState: undefined,
			saveNativeState: async () => {}, registerNativeAlias: async () => {},
		},
		saveRecovery: async () => {},
		capabilities: { invoke: async () => undefined },
	};
	const close = vi.fn(async () => {});
	const send = vi.fn((_message: string): AsyncIterable<AgentEvent> => (async function* () {
		yield { type: 'thinking', text: 'working' } as const;
		yield { type: 'done', durationMs: 1 } as const;
	})());
	const session: AgentSession = { send, close };
	const openSession = vi.fn(async () => session);
	const driver: AgentDriver = {
		type: 'fake', connect: async () => {}, disconnect: async () => {}, openSession,
	};
	const context = { roomType: 1, roomId: 'room-1', persona: 'legacy persona', templates: { identityAnchor: 'legacy', personaSection: '', replyContract: '' } };
	const bind = vi.fn(() => ({ aiclawUid: 'identity-1', roomId: 'room-1', chatContext: context }));
	const bridge = new LegacyDriverBridge(driver, bind, { cancelTimeoutMs: 5 });
	return { input, controller, session, close, send, openSession, bind, bridge, context };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
	const result: AgentEvent[] = [];
	for await (const event of events) result.push(event);
	return result;
}

describe('LegacyDriverBridge', () => {
	it('creates a pure one-shot run and sends only the prepared envelope, preserving legacy prompt data', async () => {
		const f = fixture();
		const run = f.bridge.createRun(f.input);
		expect(f.bind).not.toHaveBeenCalled();
		expect(f.openSession).not.toHaveBeenCalled();
		expect(f.send).not.toHaveBeenCalled();
		expect(await collect(run.events)).toEqual([{ type: 'thinking', text: 'working' }, { type: 'done', durationMs: 1 }]);
		expect(f.openSession).toHaveBeenCalledWith({ aiclawUid: 'identity-1', roomId: 'room-1', chatContext: { ...f.context, preparedSystemPrompt: '' } });
		expect(f.send).toHaveBeenCalledOnce();
		expect(f.send).toHaveBeenCalledWith(f.input.message);
		expect(() => run.events[Symbol.asyncIterator]()).toThrow('only once');
		expect(await run.cancel('later')).toEqual({ status: 'stopped' });
		await run.dispose();
		await run.dispose();
		expect(f.close).toHaveBeenCalledTimes(1);
	});

	it('never sends when cancelled before consumption or while opening', async () => {
		const f = fixture();
		const run = f.bridge.createRun(f.input);
		f.controller.abort();
		expect(await collect(run.events)).toEqual([{ type: 'cancelled', reason: 'Cancelled before submission' }]);
		expect(f.openSession).not.toHaveBeenCalled();
		expect(await run.cancel('abort')).toEqual({ status: 'stopped' });
		const g = fixture();
		let release!: (session: AgentSession) => void;
		g.openSession.mockImplementationOnce(() => new Promise<AgentSession>((resolve) => { release = resolve; }));
		const opening = g.bridge.createRun(g.input);
		const pending = collect(opening.events);
		await vi.waitFor(() => expect(g.openSession).toHaveBeenCalledOnce());
		g.controller.abort();
		expect(await opening.cancel('preparing')).toMatchObject({ status: 'unconfirmed' });
		release(g.session);
		expect(await pending).toEqual([{ type: 'cancelled', reason: 'Cancelled before submission' }]);
		expect(g.send).not.toHaveBeenCalled();
	});

	it('does not equate close or error/EOF to a confirmed stop', async () => {
		const f = fixture();
		let release!: (value: AgentEvent) => void;
		f.send.mockImplementationOnce(() => ({ [Symbol.asyncIterator]: async function* () {
			yield await new Promise<AgentEvent>((resolve) => { release = resolve; });
		} }));
		const run = f.bridge.createRun(f.input);
		const pending = collect(run.events);
		await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
		expect(await run.cancel('timeout')).toEqual({ status: 'unconfirmed', reason: 'timeout' });
		expect(await run.cancel('again')).toEqual({ status: 'unconfirmed', reason: 'timeout' });
		expect(f.close).toHaveBeenCalledOnce();
		release({ type: 'error', message: 'network error' });
		expect(await pending).toEqual([{ type: 'error', message: 'network error' }]);
		const g = fixture();
		g.send.mockImplementationOnce(() => (async function* () {})());
		const eof = g.bridge.createRun(g.input);
		expect(await collect(eof.events)).toEqual([{ type: 'error', message: 'UNEXPECTED_EOF' }]);
		expect(await eof.cancel('lost stream')).toEqual({ status: 'unconfirmed', reason: 'lost stream' });
	});

	it('actively closes on signal abort after submission without claiming stopped', async () => {
		const f = fixture();
		let release!: () => void;
		f.send.mockImplementationOnce(() => ({ [Symbol.asyncIterator]: async function* () {
			await new Promise<void>((resolve) => { release = resolve; });
		} }));
		const run = f.bridge.createRun(f.input);
		const pending = collect(run.events);
		await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
		f.controller.abort();
		await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce());
		expect(await run.cancel('not proven')).toEqual({ status: 'unconfirmed', reason: 'Aborted' });
		release();
		await pending;
	});

	it('does not confirm done before the native iterator reaches natural EOF', async () => {
		const f = fixture();
		let release!: () => void;
		const returned = vi.fn();
		f.send.mockImplementationOnce(() => ({ [Symbol.asyncIterator]: async function* () {
			try {
				yield { type: 'done', durationMs: 1 } as const;
				await new Promise<void>((resolve) => { release = resolve; });
			} finally { returned(); }
		} }));
		const run = f.bridge.createRun(f.input);
		const pending = collect(run.events);
		await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
		await vi.waitFor(() => expect(release).toBeTypeOf('function'));
		expect(returned).not.toHaveBeenCalled();
		expect(await run.cancel('still draining')).toEqual({ status: 'unconfirmed', reason: 'still draining' });
		release();
		expect(await pending).toEqual([{ type: 'cancelled', reason: 'Stop was not confirmed' }]);
	});

	it('times out an unresponsive close and forwards a prepared prompt without rendering', async () => {
		const f = fixture();
		f.close.mockImplementationOnce(() => new Promise<void>(() => {}));
		f.send.mockImplementationOnce(() => ({ [Symbol.asyncIterator]: async function* () {
			await new Promise<void>(() => {});
		} }));
		const run = f.bridge.createRun(f.input);
		void collect(run.events);
		await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
		expect(await run.cancel('stalled')).toEqual({ status: 'unconfirmed', reason: 'stalled' });
		const prepared = f.bridge.createRun({ ...f.input, systemPrompt: 'rendered exactly once' });
		const pending = collect(prepared.events);
		await vi.waitFor(() => expect(f.openSession).toHaveBeenCalledTimes(2));
		expect(f.openSession).toHaveBeenLastCalledWith({ aiclawUid: 'identity-1', roomId: 'room-1',
			chatContext: { ...f.context, preparedSystemPrompt: 'rendered exactly once' } });
		await pending;
	});
});
