import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexNativeDriver } from './native-driver.js';
import { CodexAppServer } from './app-server.js';
import { CodexTurnGrants } from './turn-grants.js';
import { ConversationStore } from '../../capability/conversations.js';
import type { AgentCapabilityInvocation, AgentEvent, BoundConversation, CapabilityExecution, NativeRef, PreparedRun } from '../events.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const release of cleanup.splice(0).reverse()) await release(); });

async function fixture() {
	const home = await mkdtemp(join(tmpdir(), 'aichat-codex-reset-'));
	const wire = join(home, 'wire');
	const script = join(home, 'native.cjs');
	// Only pinned app-server methods/notifications are on the wire. Test release files control native completion timing.
	await writeFile(script, `const fs=require('node:fs');if(process.argv.includes('--version')){console.log('codex-cli 0.142.3');process.exit(0)}
const rl=require('node:readline').createInterface({input:process.stdin});
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n'); let seq=0;
rl.on('line',line=>{const x=JSON.parse(line);fs.appendFileSync(process.env.WIRE,line+'\\n');
let result={}; const p=x.params||{};
if(x.method==='initialize')result={userAgent:'aichat/0.142.3'};
if(x.method==='thread/start'||x.method==='thread/resume')result={thread:{id:process.env.REUSE||p.threadId||'thread-'+process.env.CHANNEL,cliVersion:'0.142.3',cwd:p.cwd}};
if(x.method==='turn/start'){const id='turn-'+(++seq);result={turn:{id,status:'inProgress',items:[]}};
const timer=setInterval(()=>{if(!fs.existsSync(process.env.HOME_DIR+'/'+p.threadId+'-'+id+'.done'))return;clearInterval(timer);
send({method:'item/agentMessage/delta',params:{threadId:p.threadId,turnId:id,itemId:'answer',delta:p.threadId}});
send({method:'turn/completed',params:{threadId:p.threadId,turn:{id,status:'completed',items:[]}}});},5);}
if(x.id)send({id:x.id,result});});`);
	const options = { home, serverNamespace: 'server', activeUids: new Set(['owner']), activeProviders: new Map([['owner', 'codex']]) };
	const store = new ConversationStore(options);
	let channels = 0, reuse: string | undefined;
	const grants: CodexTurnGrants[] = [], nativeChannels: CodexAppServer[] = [];
	const driver = new CodexNativeDriver({ command: 'unused', env: process.env,
		createGrants: async () => { const grant = await CodexTurnGrants.create(); grants.push(grant); return grant; },
		createChannel: (args) => { const channel = new CodexAppServer({ command: process.execPath, prefix: [script], args,
			env: { ...process.env, WIRE: wire, HOME_DIR: home, CHANNEL: String(++channels), ...(reuse ? { REUSE: reuse } : {}) } });
			nativeChannels.push(channel); return channel; } });
	cleanup.push(async () => { await driver.disconnect(); for (const g of grants) await rm(g.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
		store.close(); await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
	const get = () => store.getOrCreate('owner', 'room', 'codex');
	const conversation = (): BoundConversation => {
		const record = get();
		return { id: record.conversationId, generation: record.generation,
			nativeState: record.nativeState.codex ? { version: 1, value: record.nativeState.codex } : undefined,
			assertCurrent: () => { store.assertGeneration('owner', 'room', record.generation); },
			async saveNativeState(state) { store.saveControlNativeState('owner', 'room', record.generation, 'codex', state.value as Record<string, unknown>); },
			async registerNativeAlias(alias) { store.registerNative('codex', alias.id, 'owner', 'room'); },
			async registerNative(id, state) { store.assertGeneration('owner', 'room', record.generation); store.registerNative('codex', id, 'owner', 'room', state.value as Record<string, unknown>); } };
	};
	const start = (runId: string, systemPrompt = 'persona-old') => {
		const bound = store.beginRun('owner', 'room', runId, { authorizationEpoch: 'epoch' });
		store.confirmReplyBindingThinking(runId, `thinking-${runId}`);
		let resolve!: (ref: NativeRef) => void;
		const native = new Promise<NativeRef>((ready) => { resolve = ready; });
		const input: PreparedRun = { runId, message: 'park', workspace: home, systemPrompt, conversation: conversation(),
			replyToken: bound.replyToken, replyThinkingId: `thinking-${runId}`, saveRecovery: async (value) => { bound.saveRecovery(value); },
			onNativeBound: resolve, signal: new AbortController().signal, capabilities: { invoke: async () => undefined } };
		const run = driver.createRun(input);
		const result = (async () => { const events: AgentEvent[] = []; for await (const event of run.events) events.push(event); store.finishRun(runId); return events; })();
		return { native, result, bound };
	};
	const command = async (requestId: string, systemPrompt = 'persona-new'): Promise<AgentCapabilityInvocation> => {
		const signal = new AbortController().signal;
		const catalog = await driver.discoverCapabilities({ workspace: home, signal });
		store.prepareControl('owner', 'room', requestId, `fingerprint-${requestId}`, 'epoch');
		const current = conversation();
		const execution: CapabilityExecution = { requestId, conversation: current, systemPrompt, contextKey: get().contextKey, promptOwner: 'owner', authorizationEpoch: 'epoch',
			async saveRecovery(value) { store.saveControlRecovery('owner', 'room', requestId, value); },
			async submitted(ref) { store.submitControl('owner', 'room', requestId, ref); },
			async selectModel() { throw new Error('reset must not set model'); },
			async replaceSession(id, state) { return store.replaceNativeSession('owner', 'room', current.generation, 'codex', id, state.value as Record<string, unknown>).generation; },
			async emit() { throw new Error('reset must not create a thinking turn'); }, async bindTurn() { throw new Error('reset must not mint a run grant'); } };
		return { capabilityId: 'session.reset', catalogVersion: catalog.version, workspace: home, signal, execution };
	};
	const lines = async () => (await readFile(wire, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
	const release = async (ref: NativeRef) => { await writeFile(join(home, `${ref.sessionId}-${ref.turnId}.done`), 'done'); };
	return { store, driver, home, start, command, lines, release, grants, nativeChannels, reuse: (id: string) => { reuse = id; } };
}

describe('native Codex reset uses a fresh thread and generation CAS', () => {
	it('keeps active old work on its exact old thread/turn and runs the next turn only on the new generation', async () => {
		const f = await fixture();
		const old = f.start('old'); const oldRef = await old.native;
		const oldGeneration = old.bound.generation;
		const invocation = await f.command('reset-1');
		const reset = await f.driver.executeCapability(invocation);
		expect(reset).toMatchObject({ status: 'completed', generation: String(oldGeneration), nativeRef: { sessionId: oldRef.sessionId }, effect: { kind: 'reset', generation: String(oldGeneration + 1) } });
		const current = f.store.get('owner', 'room')!;
		const newThread = current.nativeState.codex.threadId;
		expect(newThread).not.toBe(oldRef.sessionId);
		expect(current.replyBindingRequired).toBe(true);
		expect(current.nativeState.codex.promptHash).not.toBeUndefined();
		expect(f.store.pendingRuns('owner', 'room')).toHaveLength(1);
		expect(() => old.bound.assertCurrent()).toThrow('STALE_GENERATION');
		const next = f.start('next', 'persona-new'); const nextRef = await next.native;
		expect(nextRef.sessionId).toBe(newThread);
		await f.release(oldRef); expect(await old.result).toContainEqual({ type: 'thinking', text: oldRef.sessionId });
		await f.release(nextRef); expect(await next.result).toContainEqual({ type: 'thinking', text: newThread });
		const wire = await f.lines();
		expect(wire.filter((x) => x.method === 'thread/start').map((x) => x.id)).toEqual(['old', 'reset-1']);
		expect(wire.filter((x) => ['turn/interrupt', 'thread/fork', 'thread/rollback'].includes(x.method))).toEqual([]);
		expect(wire.filter((x) => x.method === 'thread/start').map((x) => x.params.developerInstructions)).toEqual(['persona-old', 'persona-new']);
		const count = wire.length;
		const replay = await f.driver.executeCapability({ ...invocation, execution: undefined, recovery: { generation: oldGeneration, receipt: reset } });
		expect(replay).toEqual(reset); expect(await f.lines()).toHaveLength(count);
	});
	it('keeps a created-thread locator when CAS loses and never replays the native mutation', async () => {
		const f = await fixture(); const invocation = await f.command('cas-lost');
		invocation.execution!.replaceSession = async () => { f.store.reset('owner', 'room'); throw new Error('STALE_GENERATION'); };
		const result = await f.driver.executeCapability(invocation);
		expect(result.status).toBe('unknown');
		const recovery = f.store.getControl('owner', 'room', 'cas-lost')?.recovery;
		expect(recovery?.value).toMatchObject({ provider: 'codex', createdThreadId: expect.any(String) });
		expect(f.store.get('owner', 'room')?.nativeState).toEqual({});
		const before = await f.lines();
		await f.driver.executeCapability({ ...invocation, execution: undefined, recovery: { generation: 0, receipt: result, value: recovery } });
		expect(await f.lines()).toEqual(before); expect(before.filter((x) => x.method === 'thread/start')).toHaveLength(1);
	});
	it('returns unknown and closes the failed new channel even if its grant revocation also fails', async () => {
		const f = await fixture(); const invocation = await f.command('cas-revoke-failed');
		invocation.execution!.replaceSession = async () => {
			vi.spyOn(f.grants.at(-1)!, 'revokeAll').mockRejectedValue(new Error('injected grant IO failure'));
			throw new Error('injected CAS failure');
		};
		expect(await f.driver.executeCapability(invocation)).toMatchObject({ status: 'unknown', error: 'CODEX_GRANT_REVOKE_FAILED' });
		await expect(f.nativeChannels.at(-1)!.request('thread/read', {})).rejects.toThrow('CODEX_CHANNEL_CLOSED');
		expect(f.store.get('owner', 'room')?.nativeState).toEqual({});
	});
	it('refuses a native reset response that reuses the old thread without advancing core generation', async () => {
		const f = await fixture(); const old = f.start('old'); const ref = await old.native;
		const invocation = await f.command('reuse'); f.reuse(ref.sessionId);
		expect((await f.driver.executeCapability(invocation)).status).toBe('unknown');
		expect(f.store.get('owner', 'room')?.generation).toBe(old.bound.generation);
		await f.release(ref); expect(await old.result).toContainEqual({ type: 'thinking', text: ref.sessionId });
	});
	it('rejects UI paths and stale catalogs before any native reset submission; compact stays unsupported', async () => {
		const f = await fixture(); const invocation = await f.command('invalid');
		expect(await f.driver.executeCapability({ ...invocation, parameters: { cwd: '/untrusted' } })).toMatchObject({ status: 'failed', error: 'invalid_parameters' });
		expect(await f.driver.executeCapability({ ...invocation, catalogVersion: 'stale' })).toMatchObject({ status: 'failed', error: 'catalog_stale' });
		expect(await f.driver.executeCapability({ ...invocation, capabilityId: 'session.compact' })).toMatchObject({ status: 'unsupported' });
		expect((await f.lines()).filter((x) => x.method === 'thread/start')).toEqual([]);
		expect(f.store.getControl('owner', 'room', 'invalid')?.state).toBe('prepared');
	});
});
