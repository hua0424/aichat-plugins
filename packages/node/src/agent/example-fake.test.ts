import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDriver } from './descriptor.js';
import type { AgentEvent } from './events.js';
import { fakeDescriptor } from './example-fake.js';
import { ConversationStore } from '../capability/conversations.js';
import { CapabilityRegistry } from '../capability/registry.js';
import { MessageHandler } from '../handler/message.js';
import type { HulaApiClient } from '../api/hula-api.js';
import type { HulaWSClient } from '../server/hula-ws.js';
import { WSReqType } from '../stream/protocol.js';

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

const entry = { tool: 'fake', token: 'test-only' };
const descriptors = new Map([['fake', fakeDescriptor]]);

function fixture() {
	const home = mkdtempSync(join(tmpdir(), 'fifth-adapter-'));
	homes.push(home);
	const store = new ConversationStore({ home, serverNamespace: 'test', activeUids: new Set(['42']),
		activeProviders: new Map([['42', 'fake']]) });
	const observed: Array<{ identity: string; room: string }> = [];
	const capabilities = new CapabilityRegistry();
	capabilities.register('fake-query', async (ctx) => {
		observed.push({ identity: ctx.aiclawUid, room: ctx.roomId });
		return { visible: true };
	});
	const prompts: string[] = [];
	const probeDescriptor = { ...fakeDescriptor, create: (config: typeof entry) => {
		const driver = fakeDescriptor.create(config);
		return { ...driver, type: driver.type, features: driver.features,
			connect: () => driver.connect(), disconnect: () => driver.disconnect(),
			createRun(input: Parameters<typeof driver.createRun>[0]) {
				prompts.push(input.systemPrompt);
				return driver.createRun(input);
			} };
	} };
	const frames: Array<{ type: number; data: Record<string, unknown> }> = [];
	const ws = { isConnected: true, send: vi.fn((type: number, data: Record<string, unknown>) => {
		frames.push({ type, data });
	}) } as unknown as HulaWSClient;
	const api = { getMemberInfo: vi.fn(async () => ({ name: 'Fake Bot' })) } as unknown as HulaApiClient;
	const handler = new MessageHandler(ws, createDriver(entry, new Map([['fake', probeDescriptor]])), '42', api,
		{ waitMs: 1, maxWaitMs: 1 }, () => {}, () => store, undefined, capabilities);
	return { store, observed, frames, handler, prompts };
}

const message = { fromUser: { uid: '7', name: 'user', userType: 1 },
	message: { id: '1', roomId: '9', type: 1, roomType: 2, body: { content: 'hello' } } };

async function awaitDone(f: ReturnType<typeof fixture>) {
	await vi.waitFor(() => expect(f.store.pendingRuns()).toHaveLength(0));
}

describe('static fifth adapter contract', () => {
	it('isolates an unknown contract version without constructing its driver', () => {
		const create = vi.fn(() => createDriver(entry, descriptors));
		expect(() => createDriver(entry, new Map([['fake', { ...fakeDescriptor, contractVersion: 2, create }]])))
			.toThrow('unsupported driver contract');
		expect(create).not.toHaveBeenCalled();
		expect(() => createDriver(entry, new Map([['fake', { ...fakeDescriptor,
			context: { kind: 'native-env' as const, env: 'UNKNOWN_FAKE_ID' } }]])))
			.toThrow('native context transport not registered');
		expect(() => createDriver(entry, new Map([['fake', { ...fakeDescriptor,
			features: { ...fakeDescriptor.features, reset: 'unsupported' as const } }]])))
			.toThrow('driver contract mismatch');
		expect(() => createDriver({ ...entry, tool: 'unknown' }, descriptors)).toThrow('unsupported agent tool');
	});

	it('receives a message, emits events, invokes a new bound query and consumes prepared template changes', async () => {
		const f = fixture();
		try {
			f.handler.setPromptTemplates({ identityAnchor: 'You are {displayName} ({uid})',
				personaSection: '{persona}', replyContract: 'Reply via {reply_command}' });
			f.handler.handle({ type: 'receiveMessage', data: message } as never);
			await vi.waitFor(() => expect(f.observed).toHaveLength(1));
			await awaitDone(f);
			expect(f.observed).toEqual([{ identity: '42', room: '9' }]);
			expect(f.frames.find((frame) => frame.type === WSReqType.THINKING_START)?.data)
				.toMatchObject({ fromUid: '42', roomId: '9' });
			f.handler.setPromptTemplates({ identityAnchor: 'Changed: {displayName} ({uid})',
				personaSection: '{persona}', replyContract: 'Reply via {reply_command}' });
			f.handler.handle({ type: 'receiveMessage', data: { ...message, message: { ...message.message, id: '2' } } } as never);
			await vi.waitFor(() => expect(f.observed).toHaveLength(2));
			expect(f.observed[1]).toEqual({ identity: '42', room: '9' });
			expect(f.prompts).toHaveLength(2);
			expect(f.prompts[0]).toContain('You are Fake Bot (42)');
			expect(f.prompts[1]).toContain('Changed: Fake Bot (42)');
		} finally { f.handler.destroy(); f.store.close(); }
	});

	it('declares unsupported upstream cancellation rather than faking stop confirmation', async () => {
		const driver = createDriver(entry, descriptors);
		const input = { runId: '1', message: 'hello', systemPrompt: '', signal: new AbortController().signal,
			conversation: { id: '1', generation: 1, nativeState: undefined, assertCurrent: () => {},
				saveNativeState: async () => {}, registerNativeAlias: async () => {} },
			saveRecovery: async () => {}, capabilities: { invoke: async () => ({}) } };
		const before = driver.createRun(input);
		expect(await before.cancel('before start')).toEqual({ status: 'stopped' });
		const stoppedEvents: AgentEvent[] = [];
		for await (const event of before.events) stoppedEvents.push(event);
		expect(stoppedEvents).toEqual([{ type: 'cancelled', reason: 'Cancelled before submission' }]);
		const run = driver.createRun(input);
		const events = run.events[Symbol.asyncIterator]();
		expect((await events.next()).value).toEqual({ type: 'thinking', text: 'Received: hello' });
		expect(await run.cancel('after submission')).toEqual({ status: 'unsupported' });
		await events.return?.();
	});
});
