import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexNativeDriver } from './native-driver.js';
import { CodexAppServer } from './app-server.js';
import { CodexTurnGrants } from './turn-grants.js';
import { ConversationStore } from '../../capability/conversations.js';
import type { AgentCapabilityInvocation, BoundConversation, CapabilityExecution } from '../events.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

async function fixture(mode = '') {
	const home = await mkdtemp(join(tmpdir(), 'aichat-codex-model-'));
	const wire = join(home, 'wire'), inventory = join(home, 'inventory.json'), script = join(home, 'native.cjs');
	const skillPath = join(home, 'private-native-skill.md');
	await writeFile(skillPath, 'native test skill');
	await writeFile(inventory, JSON.stringify([{ name: 'local-skill', scope: 'user', path: skillPath, description: 'Native skill', enabled: true }]));
	await writeFile(script, `const fs=require('node:fs');if(process.argv.includes('--version')){console.log('codex-cli 0.142.3');process.exit(0)}
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');let model='model-000',seq=0;
const all=Array.from({length:205},(_,i)=>({id:'entry-'+i,model:'model-'+String(i).padStart(3,'0'),displayName:'Model '+i,description:'Native model',hidden:i===204,
upgrade:null,upgradeInfo:null,availabilityNux:null,supportedReasoningEfforts:[],defaultReasoningEffort:'medium',inputModalities:['text'],supportsPersonality:false,additionalSpeedTiers:[],serviceTiers:[],defaultServiceTier:null,isDefault:i===0}));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const x=JSON.parse(line),p=x.params||{};fs.appendFileSync(process.env.WIRE,line+'\\n');let result={};
if(x.method==='initialize')result={userAgent:'aichat/0.142.3'};
if(x.method==='config/read')result={config:{model_provider:process.env.MODE==='provider-null'?null:'openai'},origins:{},layers:null};
if(x.method==='skills/list')result={data:[{cwd:process.env.MODE==='wrong-cwd'?'/untrusted':p.cwds[0],skills:JSON.parse(fs.readFileSync(process.env.INVENTORY,'utf8')),errors:process.env.MODE==='scan-error'?[{path:'/private',message:'scan failed'}]:[]}]};
if(x.method==='model/list'){const at=p.cursor?Number(p.cursor):0;result={data:all.slice(at,at+100),nextCursor:at+100<all.length?String(at+100):null};if(process.env.MODE==='cursor-loop')result.nextCursor='100';}
if(x.method==='thread/start'||x.method==='thread/resume')result={thread:{id:p.threadId||'thread-'+process.env.CHANNEL,cliVersion:'0.142.3',cwd:p.cwd},model,modelProvider:process.env.MODE==='provider-mismatch'?'other':'openai'};
if(x.method==='thread/settings/update'){if(process.env.MODE==='drop-settings')return;if(process.env.MODE==='error-settings'){send({id:x.id,error:{code:-32000,message:'native rejected'}});return;}model=p.model;send({method:'thread/settings/updated',params:{threadId:p.threadId,threadSettings:{cwd:process.env.HOME_DIR,approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'},model,modelProvider:'openai'}}});}
if(x.method==='turn/start'){const id='turn-'+(++seq);result={turn:{id,status:'inProgress',items:[]}};setTimeout(()=>{send({method:'item/agentMessage/delta',params:{threadId:p.threadId,turnId:id,itemId:'answer',delta:model}});send({method:'turn/completed',params:{threadId:p.threadId,turn:{id,status:'completed',items:[]}}});},10);}
if(x.id)send({id:x.id,result});});`);
	const store = new ConversationStore({ home, serverNamespace: 'server', activeUids: new Set(['owner']), activeProviders: new Map([['owner', 'codex']]) });
	const grants: CodexTurnGrants[] = [], channels: CodexAppServer[] = [];
	const driver = new CodexNativeDriver({ command: 'unused', env: process.env,
		createGrants: async () => { const grant = await CodexTurnGrants.create(); grants.push(grant); return grant; },
		createChannel: (args) => { const channel = new CodexAppServer({ command: process.execPath, prefix: [script], args, timeoutMs: 3000,
			env: { ...process.env, WIRE: wire, INVENTORY: inventory, HOME_DIR: home, MODE: mode, CHANNEL: String(channels.length + 1) } });
			channels.push(channel); return channel; } });
	cleanup.push(async () => { await driver.disconnect(); store.close(); for (const grant of grants) await rm(grant.directory, { recursive: true, force: true }); await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
	const record = () => store.getOrCreate('owner', 'room', 'codex');
	const conversation = (): BoundConversation => {
		const r = record();
		return { id: r.conversationId, generation: r.generation, nativeState: r.nativeState.codex ? { version: 1, value: r.nativeState.codex } : undefined,
			assertCurrent() { store.assertGeneration('owner', 'room', r.generation); },
			async saveNativeState(value) { store.saveControlNativeState('owner', 'room', r.generation, 'codex', value.value as Record<string, unknown>); },
			async registerNativeAlias(alias) { store.registerNative('codex', alias.id, 'owner', 'room'); },
			async registerNative(id, state) { store.assertGeneration('owner', 'room', r.generation); store.registerNative('codex', id, 'owner', 'room', state.value as Record<string, unknown>); } };
	};
	const signal = new AbortController().signal;
	const discover = (parameters = {}) => driver.discoverCapabilities({ workspace: home, signal, capabilityId: 'model.set', parameters });
	const invoke = async (requestId: string, parameters: Record<string, unknown> = { providerId: 'openai', modelId: 'model-204' }): Promise<AgentCapabilityInvocation> => {
		const catalog = await discover(), current = conversation();
		store.prepareControl('owner', 'room', requestId, requestId, 'epoch');
		const execution: CapabilityExecution = { requestId, conversation: current, contextKey: record().contextKey, authorizationEpoch: 'epoch', systemPrompt: 'frozen persona', promptOwner: 'owner',
			async saveRecovery(value) { store.saveControlRecovery('owner', 'room', requestId, value); },
			async submitted(ref) { store.submitControl('owner', 'room', requestId, ref); },
			async selectModel(model) { store.selectModel('owner', 'room', current.generation, model); },
			async replaceSession() { throw new Error('model control must not reset'); }, async emit() { throw new Error('model control must not create turn'); }, async bindTurn() { throw new Error('model control must not create grant'); } };
		return { capabilityId: 'model.set', parameters, catalogVersion: catalog.version, workspace: home, signal, execution };
	};
	const lines = async () => (await readFile(wire, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
	const chat = async () => {
		const runId = 'ordinary-turn', bound = store.beginRun('owner', 'room', runId, { authorizationEpoch: 'epoch' });
		store.confirmReplyBindingThinking(runId, 'thinking-exact');
		const run = driver.createRun({ runId, message: 'next response', workspace: home, systemPrompt: 'frozen persona', conversation: conversation(),
			replyToken: bound.replyToken, replyThinkingId: 'thinking-exact', saveRecovery: async (value) => bound.saveRecovery(value),
			assertReplySettlement: (ref) => bound.assertReplySettlement(ref), signal, capabilities: { invoke: async () => undefined } });
		const events = []; for await (const event of run.events) events.push(event);
		await run.dispose(); store.finishRun(runId); return events;
	};
	return { home, skillPath, inventory, driver, store, signal, discover, invoke, lines, chat, grants, channels };
}

describe('Codex native catalog and model control', () => {
	it('reads every native cursor then applies public pagination without changing catalog version', async () => {
		const f = await fixture();
		const first = await f.discover(), second = await f.discover({ offset: 100 }), last = await f.discover({ offset: 200 });
		expect(first.models).toMatchObject({ total: 205, offset: 0, nextOffset: 100 }); expect(first.models!.items).toHaveLength(100);
		expect(first.models!.items.every((m) => m.connected === false)).toBe(true); // No native connection-status signal.
		expect(second.models).toMatchObject({ total: 205, offset: 100, nextOffset: 200 }); expect(last.models!.items).toHaveLength(5);
		expect(second.version).toBe(first.version); expect(last.version).toBe(first.version);
		const query = await f.discover({ query: 'model-204' }); expect(query.models!.items.map((m) => m.modelId)).toEqual(['model-204']); expect(query.version).toBe(first.version);
		const pages = (await f.lines()).filter((x) => x.method === 'model/list');
		expect(pages.slice(0, 3).map((x) => x.params)).toEqual([{ limit: 100, includeHidden: true }, { limit: 100, includeHidden: true, cursor: '100' }, { limit: 100, includeHidden: true, cursor: '200' }]);
		expect(JSON.stringify(first)).not.toContain(f.skillPath); expect(first.capabilities.find((c) => c.id === 'skill:local-skill')).toMatchObject({ supported: true, executable: false, reason: 'execution_not_connected' });
	});
	it('binds catalog version to native skill path and namespace without exposing them', async () => {
		const f = await fixture(), first = await f.discover();
		const data = JSON.parse(await readFile(f.inventory, 'utf8')); data[0].path = join(f.home, 'other-private-path'); data[0].scope = 'repo';
		await writeFile(f.inventory, JSON.stringify(data)); const next = await f.discover(); expect(next.version).not.toBe(first.version); expect(JSON.stringify(next)).not.toContain(data[0].path);
		data.push({ ...data[0], path: f.skillPath, scope: 'user' }); await writeFile(f.inventory, JSON.stringify(data));
		expect((await f.discover()).capabilities.find((c) => c.id === 'skill:local-skill')).toMatchObject({ supported: false, executable: false, reason: 'native_skill_namespace_ambiguous' });
		data.pop(); data[0].enabled = false; await writeFile(f.inventory, JSON.stringify(data));
		expect((await f.discover()).capabilities.find((c) => c.id === 'skill:local-skill')).toMatchObject({ supported: false, executable: false, reason: 'native_skill_disabled' });
	});
	it('rejects untrusted UI cwd/path before native discovery and leaves skills unconnected', async () => {
		const f = await fixture(); await expect(f.discover({ path: f.skillPath })).rejects.toThrow('invalid_parameters'); expect(await f.lines()).toEqual([]);
		const request = await f.invoke('bad-path', { providerId: 'openai', modelId: 'model-204', cwd: f.home });
		expect(await f.driver.executeCapability(request)).toMatchObject({ status: 'failed', error: 'invalid_parameters' }); expect((await f.lines()).some((x) => x.method === 'thread/start')).toBe(false);
	});
	for (const [mode, error] of [['scan-error', 'CODEX_NATIVE_SKILLS_ERRORS'], ['wrong-cwd', 'CODEX_NATIVE_DISCOVERY_UNVERIFIED'], ['cursor-loop', 'CODEX_NATIVE_DISCOVERY_CURSOR_REPEATED']]) {
		it(`fails closed for ${mode}`, async () => { const f = await fixture(mode); await expect(f.discover()).rejects.toThrow(error); });
	}
	it('does not invent a provider when native config leaves it unresolved', async () => {
		const f = await fixture('provider-null'), catalog = await f.discover(); expect(catalog.models!.items).toEqual([]);
		expect(catalog.capabilities.find((c) => c.id === 'model.set')).toMatchObject({ supported: false, executable: false, reason: 'native_provider_unverified' });
		expect(await f.driver.executeCapability(await f.invoke('unresolved'))).toMatchObject({ status: 'unsupported', error: 'native_provider_unverified' });
		expect((await f.lines()).some((x) => x.method === 'thread/start' || x.method === 'thread/settings/update')).toBe(false);
	});
	it('uses real settings control and the next native turn, reporting same-value ACK as accepted too', async () => {
		const f = await fixture(), request = await f.invoke('set-1');
		expect(await f.driver.executeCapability(request)).toMatchObject({ status: 'accepted', phase: 'outcome', effect: { kind: 'model', modelId: 'model-204', effective: 'next_request' } });
		expect(await f.chat()).toContainEqual({ type: 'thinking', text: 'model-204' });
		const same = await f.invoke('same-value'); const accepted = await f.driver.executeCapability(same); expect(accepted.status).toBe('accepted'); expect(JSON.stringify(accepted)).not.toContain('changed');
		const controls = (await f.lines()).filter((x) => x.method === 'thread/settings/update');
		const threadId = controls[0].params.threadId; expect(typeof threadId).toBe('string');
		expect(controls.map((x) => [x.id, x.params])).toEqual([['set-1', { threadId, model: 'model-204' }], ['same-value', { threadId, model: 'model-204' }]]);
		expect((await f.lines()).filter((x) => ['thread/fork', 'thread/rollback', 'turn/interrupt'].includes(x.method))).toEqual([]);
	});
	it('rejects a changed native catalog before creating a model-control thread', async () => {
		const f = await fixture(), request = await f.invoke('stale');
		const data = JSON.parse(await readFile(f.inventory, 'utf8')); data[0].path = join(f.home, 'changed-path'); await writeFile(f.inventory, JSON.stringify(data));
		expect(await f.driver.executeCapability(request)).toMatchObject({ status: 'failed', error: 'catalog_stale' });
		expect((await f.lines()).some((x) => x.method === 'thread/start' || x.method === 'thread/settings/update')).toBe(false);
	});
	it('keeps a native ACK followed by a core commit failure unknown, without repeating the setting', async () => {
		const f = await fixture(), request = await f.invoke('commit-failed');
		request.execution!.selectModel = async () => { throw new Error('test disk commit rejected'); };
		const result = await f.driver.executeCapability(request); expect(result.status).toBe('unknown');
		const count = (await f.lines()).length;
		expect(await f.driver.executeCapability({ ...request, execution: undefined, recovery: { generation: 1, receipt: result } })).toEqual(result);
		expect(await f.lines()).toHaveLength(count); expect((await f.lines()).filter((x) => x.method === 'thread/settings/update')).toHaveLength(1);
	});
	it('reports retired model-channel cleanup unknown without closing the CAS-selected new thread', async () => {
		const f = await fixture(), request = await f.invoke('retired-cleanup');
		let resetResult: Awaited<ReturnType<CodexNativeDriver['executeCapability']>> | undefined;
		request.execution!.selectModel = async () => {
			const reset = { ...await f.invoke('reset-during-control', {}), capabilityId: 'session.reset' };
			const generation = reset.execution!.conversation.generation;
			reset.execution!.replaceSession = async (id, state) => f.store.replaceNativeSession('owner', 'room', generation, 'codex', id, state.value as Record<string, unknown>).generation;
			resetResult = await f.driver.executeCapability(reset);
			vi.spyOn(f.grants[0], 'dispose').mockRejectedValueOnce(new Error('test retired cleanup IO failure'));
		};
		const result = await f.driver.executeCapability(request);
		expect(resetResult).toMatchObject({ status: 'completed', effect: { kind: 'reset' } });
		expect(result).toMatchObject({ status: 'unknown', error: 'CODEX_MODEL_CLEANUP_UNCONFIRMED' });
		await expect(f.channels[1].request('thread/read', {})).rejects.toThrow('CODEX_CHANNEL_CLOSED');
		await expect(f.channels[2].request('thread/read', {})).resolves.toEqual({});
		expect((await f.lines()).filter((x) => x.method === 'turn/interrupt')).toEqual([]);
	});
	it('refuses a native thread provider mismatch without settings mutation', async () => {
		const f = await fixture('provider-mismatch'); expect(await f.driver.executeCapability(await f.invoke('mismatch'))).toMatchObject({ status: 'failed', error: 'native_provider_mismatch' });
		expect((await f.lines()).some((x) => x.method === 'thread/settings/update')).toBe(false);
	});
	for (const mode of ['drop-settings', 'error-settings']) {
		it(`keeps ${mode} unknown and read-only on recovery without resending`, async () => {
			const f = await fixture(mode), request = await f.invoke('unknown'); const result = await f.driver.executeCapability(request);
			expect(result).toMatchObject({ status: 'unknown', error: 'native_model_outcome_unconfirmed' }); const count = (await f.lines()).length;
			expect(await f.driver.executeCapability({ ...request, execution: undefined, recovery: { generation: 1, receipt: result } })).toEqual(result);
			expect(await f.lines()).toHaveLength(count); expect((await f.lines()).filter((x) => x.method === 'thread/settings/update')).toHaveLength(1);
		});
	}
});
