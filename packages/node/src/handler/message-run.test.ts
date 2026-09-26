import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageHandler } from './message.js';
import { ConversationStore } from '../capability/conversations.js';
import { WSReqType } from '../stream/protocol.js';
import type { AgentDriver, AgentEvent, AgentSession } from '../agent/events.js';
import type { HulaWSClient } from '../server/hula-ws.js';
import type { ReceivedMessage } from '../stream/protocol.js';
import { CcHeadlessDriver, type CcChild, type CcSpawnFn } from '../agent/cc/headless-driver.js';
import { InMemoryBindTokenStore } from '../agent/bind-token-store.js';
import { CcSessionRegistry } from '../agent/cc/sink.js';
import type { CcHeadlessSessionStore, StoredCcHeadlessSession } from '../agent/cc/headless-session-store.js';

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
const message = (id: number): ReceivedMessage => ({
	fromUser: { uid: '7', name: 'user', userType: 1 },
	message: { id: String(id), roomId: '9', type: 1, roomType: 2, body: { content: `message ${id}` } },
}) as ReceivedMessage;

function setup() {
	const home = mkdtempSync(join(tmpdir(), 'handler-run-'));
	homes.push(home);
	const store = new ConversationStore({ home, serverNamespace: 'test', activeUids: new Set(['42']) });
	const sent: number[] = [];
	const ws = { isConnected: true, send: vi.fn((type: number) => {
		if (type === WSReqType.THINKING_START) expect(store.pendingRuns()).toHaveLength(1);
		sent.push(type);
	}) } as unknown as HulaWSClient;
	let emit: ((event: AgentEvent) => void) | undefined;
	const close = vi.fn(async () => {}); // close() resolves but does NOT stop this stream.
	const driver = { type: 'cc', openSession: vi.fn(async () => ({
		send: (_text: string) => ({ async *[Symbol.asyncIterator]() {
			const queue: AgentEvent[] = [];
			let wake: (() => void) | undefined;
			emit = (event) => { queue.push(event); wake?.(); };
			while (true) {
				if (queue.length) { const event = queue.shift()!; yield event; if (event.type === 'done' || event.type === 'error') return; }
				else await new Promise<void>((resolve) => { wake = resolve; });
			}
		} }), close,
	}) as AgentSession), finalizeThinking: (s: string) => s } as unknown as AgentDriver & { openSession: ReturnType<typeof vi.fn> };
	const handler = new MessageHandler(ws, driver, '42', undefined, { waitMs: 1, maxWaitMs: 1 }, () => {}, () => store);
	return { store, sent, driver, close, handler, emit: (event: AgentEvent) => emit?.(event) };
}

describe('persisted MessageHandler run', () => {
	it('bridges a real CC driver to persistent run completion after native EOF', async () => {
		const home = mkdtempSync(join(tmpdir(), 'handler-cc-'));
		homes.push(home);
		const store = new ConversationStore({ home, serverNamespace: 'test', activeUids: new Set(['42']), activeProviders: new Map([['42', 'cc']]) });
		const sessions = new Map<string, StoredCcHeadlessSession>();
		const sessionStore: CcHeadlessSessionStore = {
			get: (key) => sessions.get(key), set: (key, value) => void sessions.set(key, value), delete: (key) => void sessions.delete(key),
		};
		const stdoutEnd: Array<() => void> = [];
		const writes: string[] = [];
		const child: CcChild = {
			pid: 1251, stdin: { write: (text) => void writes.push(text), end: () => {} },
			stdout: { on: (event: string, cb: (...args: never[]) => void) => {
				if (event === 'end' || event === 'close') stdoutEnd.push(cb as () => void);
			} } as CcChild['stdout'],
			stderr: { on: () => {} } as CcChild['stderr'], on: () => {}, kill: () => true,
		};
		let argv: readonly string[] = [];
		const spawn: CcSpawnFn = (_command, args) => { argv = args; return child; };
		const driver = new CcHeadlessDriver({
			workspaceBase: home, brokerPort: 9100, sessionStore,
			bindTokens: new InMemoryBindTokenStore(), registry: new CcSessionRegistry(),
			transcript: { append: () => {} }, spawn, firstEventTimeoutMs: 1000, drainMs: 5, killGraceMs: 20,
		});
		const sent: number[] = [];
		const ws = { isConnected: true, send: (type: number) => void sent.push(type) } as HulaWSClient;
		const handler = new MessageHandler(ws, driver, '42', undefined, { waitMs: 1, maxWaitMs: 1 }, () => {}, () => store);
		handler.setPromptTemplates({ identityAnchor: 'identity:{uid}', personaSection: 'persona:{persona}', replyContract: 'reply-contract:{reply_command}' });
		handler.handle({ type: 'receiveMessage', data: message(30) } as never);
		for (let i = 0; i < 30 && !writes.length; i++) await tick();
		expect(writes).toHaveLength(1);
		expect(JSON.parse(writes[0].trim()).message.content[0].text).toBe('[HuLa 私聊]\n[user(7)]: message 30');
		expect(argv.filter((arg) => arg === '--append-system-prompt')).toHaveLength(1);
		expect(argv[argv.indexOf('--append-system-prompt') + 1].match(/identity:42/g)).toHaveLength(1);
		expect(store.pendingRuns()).toHaveLength(1);
		stdoutEnd.forEach((end) => end());
		for (let i = 0; i < 30 && store.pendingRuns().length; i++) await tick();
		expect(store.pendingRuns()).toHaveLength(0);
		expect(sent).toContain(WSReqType.THINKING_END);
		handler.destroy();
		store.close();
	});
	it('holds the room and queue after reset when legacy close has no stop proof', async () => {
		const { handler, store, sent, driver, close } = setup();
		handler.handle({ type: 'receiveMessage', data: message(1) } as never);
		await tick();
		expect(driver.openSession).toHaveBeenCalledTimes(1);
		store.reset('42', '9');
		await handler.cancelRun('9');
		expect(close).toHaveBeenCalled();
		expect(store.get('42', '9')?.state).toBe('stop_unconfirmed');
		handler.handle({ type: 'receiveMessage', data: message(2) } as never);
		await tick();
		expect(driver.openSession).toHaveBeenCalledTimes(1);
		expect(sent.filter((type) => type === WSReqType.THINKING_START)).toHaveLength(1);
		handler.destroy();
		await tick();
		store.close();
	});

	it('does not flush queued messages when upstream emits error without stop proof', async () => {
		const { handler, store, driver, emit } = setup();
		handler.handle({ type: 'receiveMessage', data: message(20) } as never);
		await tick();
		handler.handle({ type: 'receiveMessage', data: message(21) } as never);
		emit({ type: 'error', message: 'upstream failed' });
		await tick();
		expect(driver.openSession).toHaveBeenCalledTimes(1);
		expect(store.get('42', '9')?.state).toBe('stop_unconfirmed');
		expect(store.pendingRuns()).toHaveLength(1);
		handler.destroy();
		await tick();
		store.close();
	});

	it('releases a cleanly completed stream and drains queued room messages', async () => {
		const { handler, store, driver, emit } = setup();
		handler.handle({ type: 'receiveMessage', data: message(10) } as never);
		await tick();
		handler.handle({ type: 'receiveMessage', data: message(11) } as never);
		emit({ type: 'done', durationMs: 1 });
		await tick();
		expect(driver.openSession).toHaveBeenCalledTimes(2);
		expect(store.pendingRuns()).toHaveLength(1);
		const secondRunId = store.pendingRuns()[0].runId;
		await handler.cancelRun('9', 'old-reset-run');
		expect(store.pendingRuns()[0].runId).toBe(secondRunId);
		handler.destroy();
		await tick();
		store.close();
	});
});
