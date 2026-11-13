import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexNativeDriver } from './native-driver.js';
import { CodexAppServer } from './app-server.js';
import { CodexTurnGrants } from './turn-grants.js';
import { ConversationStore } from '../../capability/conversations.js';
import { MessageHandler } from '../../handler/message.js';
import type { HulaWSClient } from '../../server/hula-ws.js';
import type { HulaApiClient } from '../../api/hula-api.js';
import type { AgentCommandResponse } from '../../stream/protocol.js';
// Fake-child process startup/JSONL under a full Windows suite is not Vitest's 1s observation default.
const waitFor = <T>(callback: () => T | Promise<T>) => vi.waitFor(callback, { timeout: 3000 });
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
async function fixture(mode = '') {
 const home = await mkdtemp(join(tmpdir(), 'codex-skill-')), wire = join(home, 'wire'), script = join(home, 'child.cjs'), path = join(home, 'trusted-skill.md');
 await writeFile(path, 'deterministic fake skill');
 await writeFile(script, `const fs=require('node:fs');if(process.argv.includes('--version')){console.log('codex-cli 0.142.3');process.exit(0)}const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');let seq=0;
 require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line),p=r.params||{};fs.appendFileSync(process.env.WIRE,line+'\\n');let result={},deferAck=false;
 if(r.method==='initialize')result={userAgent:'aichat/0.142.3'};
 if(r.method==='config/read')result={config:{model_provider:'openai'}};
 if(r.method==='skills/list')result={data:[{cwd:p.cwds[0],skills:[{name:'probe',scope:'user',path:process.env.SKILL,enabled:true,description:'native'}],errors:[]}]};
 if(r.method==='model/list')result={data:[],nextCursor:null};
 if(r.method==='thread/start'){const n=Number(fs.existsSync(process.env.THREADS)?fs.readFileSync(process.env.THREADS,'utf8'):0)+1;fs.writeFileSync(process.env.THREADS,String(n));result={thread:{id:'thread-'+n,cwd:p.cwd,cliVersion:'0.142.3'}};}
 if(r.method==='thread/resume')result={thread:{id:p.threadId,cwd:p.cwd,cliVersion:'0.142.3'}};
 if(r.method==='turn/start'){const n=++seq,id=process.env.MODE==='attach-prewarmed'&&n===1?'seed-turn':process.env.MODE.startsWith('attach')?'turn-1':'turn-'+n;deferAck=process.env.MODE==='attach-late-ack'&&n===1;result={turn:{id:'submission-'+n,status:'inProgress',items:[]}};
 const proof={method:'item/started',params:{threadId:p.threadId,turnId:id,item:{id:'input-'+n,type:'userMessage',clientId:p.clientUserMessageId,content:p.input}}};
 if(process.env.MODE==='foreign-client')proof.params.item.clientId='unregistered';
 if(process.env.MODE==='foreign-thread')proof.params.threadId='other-thread';
 if(process.env.MODE==='missing')setTimeout(()=>process.exit(0),50);
 else if(['gate','attach-gate'].includes(process.env.MODE)){const gate=setInterval(()=>{if(fs.existsSync(process.env.PROOF)){clearInterval(gate);send(proof);}},5);}
 else {send(proof);if(process.env.MODE==='conflict')send({...proof,params:{...proof.params,turnId:'other-turn'}});if(process.env.MODE==='duplicate')send({...proof,method:'item/completed'});}
 if(['foreign-client','foreign-thread','conflict'].includes(process.env.MODE))setTimeout(()=>process.exit(0),100);
 const poll=setInterval(()=>{if(fs.readdirSync(process.env.GRANTS).some(x=>x.endsWith('.env'))&&((process.env.MODE==='attach-prewarmed'&&n===1)||!(process.env.MODE.startsWith('attach')||process.env.MODE==='separate')||fs.existsSync(process.env.DONE))){clearInterval(poll);send({method:'item/agentMessage/delta',params:{threadId:p.threadId,turnId:id,itemId:'a',delta:'native answer'}});send({method:'turn/completed',params:{threadId:p.threadId,turn:{id,status:process.env.MODE==='native-failed'?'failed':process.env.MODE==='native-interrupted'?'interrupted':'completed',items:[]}}});}},5);}
 if(r.id){if(deferAck){const gate=setInterval(()=>{if(fs.existsSync(process.env.ACK)){clearInterval(gate);send({id:r.id,result});}},5);}else send({id:r.id,result});}});`);
 const store = new ConversationStore({ home, serverNamespace: 'server', activeUids: new Set(['u']), activeProviders: new Map([['u', 'codex']]) });
 const grants: CodexTurnGrants[] = [];
 const driver = new CodexNativeDriver({ command: 'unused', env: process.env,
  createGrants: async () => { const g = await CodexTurnGrants.create(); grants.push(g); return g; },
  createChannel: (args) => new CodexAppServer({ command: process.execPath, prefix: [script], args, timeoutMs: 3000,
   env: { ...process.env, WIRE: wire, SKILL: path, MODE: mode, GRANTS: grants.at(-1)?.directory, DONE: join(home, 'done'), PROOF: join(home, 'proof'), ACK: join(home, 'ack'), THREADS: join(home, 'threads') } }) });
 let handler!: MessageHandler, ack = true;
 const frames: Array<{ type: number; data: Record<string, unknown> }> = [], receipts: AgentCommandResponse[] = [];
 const send = vi.fn((type: number, data: Record<string, unknown>) => { frames.push({ type, data }); if (type === 20 && mode === 'start-fail') throw new Error('START transport failed'); if (type === 20 && ack) queueMicrotask(() => handler.handle({ type: 'thinkingStart', data: { ...data, fromUid: 'u', thinkingId: 'thinking-' + data.clientRunId } })); });
 const report = vi.fn(async (value: AgentCommandResponse) => { receipts.push(value); });
 handler = new MessageHandler({ send, isConnected: true } as unknown as HulaWSClient, driver, 'u', { reportAgentCommandResult: report, listSelfGroupConfigs: async () => [{ roomId: 'room', approved: 1, authorizationEpoch: 'epoch' }] } as unknown as HulaApiClient,
  { waitMs: 1, maxWaitMs: 1 }, () => {}, () => store, home);
 await handler.prewarmGroupConfigs();
 cleanup.push(async () => { handler.destroy(); await driver.disconnect(); store.close(); for (const g of grants) await rm(g.directory, { recursive: true, force: true }); await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
 const context = { roomType: 2, counterpartUid: 'owner', isOwner: true, authorizationEpoch: 'epoch' };
 const request = (requestId: string, operation = 'invoke', catalogVersion?: string, parameters = {}, capabilityId = 'skill:probe') => handler.handle({ type: 'agentCommand', data: { requestId, roomId: 'room', aiclawUid: 'u', operation, context,
  ...(operation === 'invoke' ? { capabilityId, catalogVersion, parameters } : {}) } });
 request('discover', 'discover');
 await waitFor(() => expect(receipts.find(r => r.requestId === 'discover'), JSON.stringify(receipts)).toMatchObject({ status: 'completed', catalog: expect.any(Object) }));
 const catalog = receipts.find(r => r.requestId === 'discover')!.catalog!;
 const result = async (requestId: string) => { await waitFor(() => expect(receipts.find(r => r.requestId === requestId && r.status !== 'accepted'), JSON.stringify(receipts)).toBeDefined()); return receipts.find(r => r.requestId === requestId && r.status !== 'accepted')!; };
 const lines = async () => (await readFile(wire, 'utf8')).trim().split('\n').map(x => JSON.parse(x));
 const grantPath = () => waitFor(async () => { const env = (await readdir(grants[0].directory)).find(p => p.endsWith('.env')); expect(env).toBeDefined(); return join(grants[0].directory, env!); });
 return { home, path, store, driver, grants, frames, send, receipts, request, result, lines, grantPath, catalog, context,
 ordinary() { handler.handle({ type: 'receiveMessage', data: { fromUser: { uid: 'owner', name: 'Owner', userType: 1 }, message: { id: 'ordinary', roomId: 'room', type: 1, roomType: 2, aiclaw: { isOwner: true }, body: { content: 'hello' } } } }); }, setAck(value: boolean) { ack = value; }, ackStart(index = -1) { const data = frames.filter(f => f.type === 20).at(index)!.data; handler.handle({ type: 'thinkingStart', data: { ...data, fromUid: 'u', thinkingId: 'thinking-' + data.clientRunId } }); } };
}
it('executes only the trusted catalog skill as typed input after actual native proof and exact START', async () => {
 const f = await fixture();
 f.request('skill-one', 'invoke', f.catalog.version, { arguments: 'literal $x\nsecond line' });
 expect(await f.result('skill-one')).toMatchObject({ status: 'completed', nativeRef: { sessionId: 'thread-1', turnId: 'turn-1' } });
 const turn = (await f.lines()).find(r => r.method === 'turn/start');
 expect(turn.params).toEqual({ threadId: 'thread-1', clientUserMessageId: 'skill-one', input: [{ type: 'skill', name: 'probe', path: f.path }, { type: 'text', text: 'literal $x\nsecond line', text_elements: [] }] });
 expect(JSON.stringify(f.catalog)).not.toContain(f.path);
 expect(f.frames.filter(x => x.type === 20)).toHaveLength(1); expect(f.frames.filter(x => x.type === 22)).toHaveLength(1);
 expect((await f.lines()).filter(r => r.method === 'turn/interrupt')).toHaveLength(0);
 expect(await readdir(f.grants[0].directory)).not.toContain('submission-1.env');
});
it('deduplicates repeated actual input notifications and never replays a completed request', async () => {
 const f = await fixture('duplicate'); f.request('once', 'invoke', f.catalog.version);
 expect(await f.result('once')).toMatchObject({ status: 'completed' });
 f.request('once', 'invoke', f.catalog.version);
 await waitFor(() => expect(f.receipts.filter(r => r.requestId === 'once' && r.status === 'completed')).toHaveLength(2));
 expect((await f.lines()).filter(r => r.method === 'turn/start')).toHaveLength(1);
 expect(f.frames.filter(x => x.type === 20)).toHaveLength(1); expect(f.frames.filter(x => x.type === 22)).toHaveLength(1);
});
it.each([false, true])('waits for the exact new START receipt and refuses an expired lease with expiry=%s', async expired => {
 const f = await fixture(); f.setAck(false); f.request('barrier', 'invoke', f.catalog.version);
 await waitFor(() => expect(f.frames.filter(x => x.type === 20)).toHaveLength(1));
 expect((await readdir(f.grants[0].directory)).filter(x => x.endsWith('.env'))).toEqual([]);
 expect(f.receipts.filter(r => r.requestId === 'barrier' && r.status === 'accepted')).toHaveLength(0);
 if (expired) vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 9 * 24 * 60 * 60 * 1000);
 f.ackStart();
 expect(await f.result('barrier')).toMatchObject({ status: expired ? 'unknown' : 'completed' });
 if (expired) expect((await readdir(f.grants[0].directory)).filter(x => x.endsWith('.env'))).toEqual([]);
 expect((await f.lines()).filter(r => r.method === 'turn/interrupt')).toHaveLength(0);
});
it('attaches a busy/racing input only to the original frozen START lease with zero mint or grant replacement', async () => {
 const f = await fixture('attach'), mint = vi.spyOn(f.store, 'beginRun');
 f.request('first', 'invoke', f.catalog.version);
 await waitFor(() => expect(f.receipts.find(r => r.requestId === 'first' && r.status === 'accepted')).toBeDefined());
 const env = await f.grantPath(), token = await readFile(env, 'utf8');
 const grant = vi.spyOn(f.grants[0], 'grant'), revoke = vi.spyOn(f.grants[0], 'revoke');
 f.request('second', 'invoke', f.catalog.version, { arguments: 'still native input' });
 await waitFor(() => expect(f.receipts.find(r => r.requestId === 'second' && r.status === 'accepted')).toBeDefined());
 expect(mint).toHaveBeenCalledTimes(1); expect(grant).not.toHaveBeenCalled(); expect(revoke).not.toHaveBeenCalled();
 expect(await readFile(env, 'utf8')).toBe(token);
 expect(f.frames.filter(x => x.type === 20)).toHaveLength(1);
 await writeFile(join(f.home, 'done'), '1');
 expect(await f.result('first')).toMatchObject({ status: 'completed', nativeRef: { turnId: 'turn-1' } });
 expect(await f.result('second')).toMatchObject({ status: 'completed', nativeRef: { turnId: 'turn-1' } });
 expect(f.frames.filter(x => x.type === 22)).toHaveLength(1);
 expect((await f.lines()).filter(r => r.method === 'turn/start')).toHaveLength(2);
 expect((await f.lines()).filter(r => r.method === 'turn/interrupt')).toHaveLength(0);
});
it.each(['attach', 'attach-late-ack', 'attach-recovery-pause'])('registers the ordinary original lease on real proof before skill authority with %s', async mode => {
 const f = await fixture(mode), mint = vi.spyOn(f.store, 'beginRun');
 let resume!: () => void, paused = false;
 const gate = new Promise<void>(resolve => { resume = resolve; });
 if (mode === 'attach-recovery-pause') {
  const create = f.driver.createRun.bind(f.driver);
  vi.spyOn(f.driver, 'createRun').mockImplementation(input => create({ ...input, get replyThinkingId() { return input.replyThinkingId; }, saveRecovery: async value => {
   if ((value.value as { nativeRef?: unknown }).nativeRef) { paused = true; await gate; }
   await input.saveRecovery(value);
  } }));
 }
 f.ordinary();
 await waitFor(async () => expect((await f.lines()).filter(r => r.method === 'turn/start')).toHaveLength(1));
 if (mode === 'attach-recovery-pause') await waitFor(() => expect(paused).toBe(true));
 if (mode === 'attach') await f.grantPath();
 const first = f.frames.find(frame => frame.type === 20)!, token = f.store.get('u', 'room')!.replyBindings!.find(b => b.runId === first.data.clientRunId)!.token;
 const grant = vi.spyOn(f.grants[0], 'grant'), revoke = vi.spyOn(f.grants[0], 'revoke');
 f.request('attached', 'invoke', f.catalog.version);
 await waitFor(() => expect(f.receipts.find(r => r.requestId === 'attached' && r.status === 'accepted'), JSON.stringify(f.receipts)).toBeDefined());
 expect(mint).toHaveBeenCalledTimes(1); expect(f.frames.filter(frame => frame.type === 20)).toHaveLength(1);
 expect(grant).not.toHaveBeenCalled(); expect(revoke).not.toHaveBeenCalled();
 resume(); await writeFile(join(f.home, 'ack'), '1');
 expect(await readFile(await f.grantPath(), 'utf8')).toContain(token);
 await writeFile(join(f.home, 'done'), '1');
 expect(await f.result('attached')).toMatchObject({ status: 'completed', nativeRef: { turnId: 'turn-1' } });
 await waitFor(() => expect(f.frames.filter(frame => frame.type === 22)).toHaveLength(1));
 expect((await f.lines()).filter(r => r.method === 'turn/interrupt')).toHaveLength(0);
});
it('does not mint from map absence after the proven ordinary owner lease expired', async () => {
 const f = await fixture('attach-gate'), mint = vi.spyOn(f.store, 'beginRun');
 f.ordinary(); await waitFor(async () => expect((await f.lines()).filter(r => r.method === 'turn/start')).toHaveLength(1));
 vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 9 * 24 * 60 * 60 * 1000);
 await writeFile(join(f.home, 'proof'), '1');
 await waitFor(() => expect(f.store.get('u', 'room')!.pendingRuns[0]?.recovery?.value).toMatchObject({ nativeRef: { turnId: 'turn-1' } }));
 f.request('unregistered-owner', 'invoke', f.catalog.version);
 expect((await f.result('unregistered-owner')).status).toBe('unknown');
 expect(mint).toHaveBeenCalledTimes(1); expect(f.frames.filter(frame => frame.type === 20)).toHaveLength(1);
 expect((await readdir(f.grants[0].directory)).filter(p => p.endsWith('.env'))).toHaveLength(0);
 expect((await f.lines()).filter(r => r.method === 'turn/interrupt')).toHaveLength(0);
});
it('allows a proved different turn on the same thread instead of treating pending ordinary work as busy authority', async () => {
 const f = await fixture('separate'), mint = vi.spyOn(f.store, 'beginRun');
 f.ordinary(); await f.grantPath(); f.request('different-turn', 'invoke', f.catalog.version);
 await waitFor(() => expect(f.receipts.find(r => r.requestId === 'different-turn' && r.status === 'accepted')).toBeDefined());
 expect(mint).toHaveBeenCalledTimes(2); expect(f.frames.filter(frame => frame.type === 20)).toHaveLength(2);
 await writeFile(join(f.home, 'done'), '1'); expect(await f.result('different-turn')).toMatchObject({ status: 'completed', nativeRef: { turnId: 'turn-2' } });
 await waitFor(() => expect(f.frames.filter(frame => frame.type === 22)).toHaveLength(2));
 expect((await f.lines()).filter(r => r.method === 'turn/interrupt')).toHaveLength(0);
});
it('does not reuse an ended original turn as authority for a fresh request', async () => {
 const f = await fixture('attach'), mint = vi.spyOn(f.store, 'beginRun');
 f.ordinary(); await f.grantPath(); await writeFile(join(f.home, 'done'), '1');
 await waitFor(() => expect(f.store.pendingRuns('u', 'room')).toHaveLength(0));
 f.request('after-end', 'invoke', f.catalog.version); expect((await f.result('after-end')).status).toBe('unknown');
 expect(mint).toHaveBeenCalledTimes(1); expect(f.frames.filter(frame => frame.type === 20)).toHaveLength(1);
 expect((await f.lines()).filter(r => r.method === 'turn/interrupt')).toHaveLength(0);
});
it('settles only the frozen ordinary old lease on late proof after reset and gives a proved new thread its own START', async () => {
 const f = await fixture('attach-gate'), mint = vi.spyOn(f.store, 'beginRun');
 f.ordinary(); await waitFor(async () => expect((await f.lines()).filter(r => r.method === 'turn/start')).toHaveLength(1));
 const old = f.store.get('u', 'room')!, oldBinding = old.replyBindings![0];
 f.request('reset', 'invoke', f.catalog.version, {}, 'session.reset'); expect((await f.result('reset')).status).toBe('completed');
 expect(f.store.get('u', 'room')!.generation).toBe(old.generation + 1);
 f.request('fresh', 'invoke', f.catalog.version);
 await waitFor(async () => expect((await f.lines()).filter(r => r.method === 'turn/start')).toHaveLength(2));
 await writeFile(join(f.home, 'proof'), '1');
 await waitFor(() => expect(f.receipts.find(r => r.requestId === 'fresh' && r.status === 'accepted'), JSON.stringify(f.receipts)).toBeDefined());
 expect(mint).toHaveBeenCalledTimes(2); expect(f.frames.filter(frame => frame.type === 20)).toHaveLength(2);
 await waitFor(async () => expect((await readdir(f.grants[0].directory)).filter(p => p.endsWith('.env'))).toHaveLength(1));
 const oldEnv = (await readdir(f.grants[0].directory)).find(p => p.endsWith('.env'))!;
 expect(await readFile(join(f.grants[0].directory, oldEnv), 'utf8')).toContain(oldBinding.token);
 await writeFile(join(f.home, 'done'), '1'); expect(await f.result('fresh')).toMatchObject({ status: 'completed', nativeRef: { sessionId: 'thread-2' } });
 await waitFor(() => expect(f.frames.filter(frame => frame.type === 22)).toHaveLength(2));
 expect((await f.lines()).filter(r => r.method === 'turn/interrupt')).toHaveLength(0);
});
it('never registers a failed ordinary START as native authority for the following skill input', async () => {
 const f = await fixture('start-fail'); f.ordinary();
 await waitFor(() => expect(f.frames.filter(frame => frame.type === 20)).toHaveLength(1));
 expect(f.store.get('u', 'room')!.replyBindings![0].thinkingId).toBeUndefined();
 expect((await f.lines()).filter(r => r.method === 'turn/start')).toHaveLength(0);
 f.request('after-failed-start', 'invoke', f.catalog.version); expect((await f.result('after-failed-start')).status).toBe('unknown');
 expect((await readdir(f.grants[0].directory)).filter(p => p.endsWith('.env'))).toHaveLength(0);
 expect((await f.lines()).filter(r => r.method === 'turn/interrupt')).toHaveLength(0);
});
it('never overwrites a capability original lease when an admitted ordinary input proves attached later', async () => {
 const f = await fixture('attach-prewarmed'); f.request('seed', 'invoke', f.catalog.version); expect((await f.result('seed')).status).toBe('completed');
 const mint = vi.spyOn(f.store, 'beginRun'); f.setAck(false); f.ordinary();
 await waitFor(() => expect(f.frames.filter(frame => frame.type === 20)).toHaveLength(2));
 f.request('cap-first', 'invoke', f.catalog.version);
 await waitFor(() => expect(f.frames.filter(frame => frame.type === 20)).toHaveLength(3));
 f.ackStart(2); await waitFor(async () => expect((await readdir(f.grants[0].directory)).filter(p => p.endsWith('.env'))).toHaveLength(2));
 const grant = vi.spyOn(f.grants[0], 'grant'), revoke = vi.spyOn(f.grants[0], 'revoke');
 f.ackStart(1);
 await waitFor(() => expect(f.frames.filter(frame => frame.type === 22)).toHaveLength(2));
 f.request('cap-attachment', 'invoke', f.catalog.version);
 await waitFor(() => expect(f.receipts.find(r => r.requestId === 'cap-attachment' && r.status === 'accepted'), JSON.stringify(f.receipts)).toBeDefined());
 expect(mint).toHaveBeenCalledTimes(2); expect(f.frames.filter(frame => frame.type === 20)).toHaveLength(3);
 expect(grant).not.toHaveBeenCalled(); expect(revoke).not.toHaveBeenCalled();
 await writeFile(join(f.home, 'done'), '1');
 expect((await f.result('cap-first')).status).toBe('completed'); expect((await f.result('cap-attachment')).status).toBe('completed');
 const capStart = f.frames.filter(frame => frame.type === 20)[2];
 expect(f.frames.filter(frame => frame.type === 22).map(frame => frame.data.thinkingId)).toContain('thinking-' + capStart.data.clientRunId);
 expect((await f.lines()).filter(r => r.method === 'turn/interrupt')).toHaveLength(0);
});
it.each(['missing', 'start-fail', 'foreign-client', 'foreign-thread', 'conflict'])('keeps %s proof/START failure unknown with zero grant and no implicit interrupt', async mode => {
 const f = await fixture(mode); f.request('failed', 'invoke', f.catalog.version);
 expect(await f.result('failed')).toMatchObject({ status: 'unknown' });
 expect((await readdir(f.grants[0].directory)).filter(x => x.endsWith('.env'))).toEqual([]);
 expect(f.receipts.filter(r => r.requestId === 'failed' && r.status === 'accepted')).toHaveLength(0);
 expect((await f.lines()).filter(r => r.method === 'turn/start')).toHaveLength(1);
 expect((await f.lines()).filter(r => r.method === 'turn/interrupt')).toHaveLength(0);
});
it.each(['expired', 'epoch'])('refuses %s attachment before map reuse without touching the original native task', async fault => {
 const f = await fixture('attach'), mint = vi.spyOn(f.store, 'beginRun');
 f.request('first', 'invoke', f.catalog.version);
 await waitFor(() => expect(f.receipts.find(r => r.requestId === 'first' && r.status === 'accepted')).toBeDefined());
 const env = await f.grantPath(), token = await readFile(env, 'utf8');
 if (fault === 'epoch') f.context.authorizationEpoch = 'next-epoch';
 else vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 9 * 24 * 60 * 60 * 1000);
 const grant = vi.spyOn(f.grants[0], 'grant'), revoke = vi.spyOn(f.grants[0], 'revoke');
 f.request('second', 'invoke', f.catalog.version);
 expect(await f.result('second')).toMatchObject({ status: 'unknown' });
 expect(mint).toHaveBeenCalledTimes(1); expect(grant).not.toHaveBeenCalled(); expect(revoke).not.toHaveBeenCalled();
 expect(await readFile(env, 'utf8')).toBe(token);
 expect(f.frames.filter(x => x.type === 20)).toHaveLength(1);
 expect((await f.lines()).filter(r => r.method === 'turn/interrupt')).toHaveLength(0);
});
it('does not start thinking from an ACK or broaden a preSTART old-generation input after reset CAS', async () => {
 const f = await fixture('gate'); f.request('late', 'invoke', f.catalog.version);
 await waitFor(async () => expect((await f.lines()).filter(r => r.method === 'turn/start')).toHaveLength(1));
 expect(f.frames.filter(x => x.type === 20)).toHaveLength(0);
 f.request('reset', 'invoke', f.catalog.version, {}, 'session.reset');
 expect(await f.result('reset')).toMatchObject({ status: 'completed' });
 await writeFile(join(f.home, 'proof'), '1');
 expect(await f.result('late')).toMatchObject({ status: 'unknown', nativeRef: { sessionId: 'thread-1', turnId: 'turn-1' } });
 expect(f.frames.filter(x => x.type === 20)).toHaveLength(0);
 expect((await readdir(f.grants[0].directory)).filter(x => x.endsWith('.env'))).toEqual([]);
 expect((await f.lines()).filter(r => r.method === 'turn/interrupt')).toHaveLength(0);
});
it.each(['native-failed', 'native-interrupted'])('closes the exact thinking lifecycle once on confirmed %s terminal without claiming background stop', async mode => {
 const f = await fixture(mode); f.request('terminal', 'invoke', f.catalog.version);
 expect(await f.result('terminal')).toMatchObject({ status: mode === 'native-failed' ? 'failed' : 'unknown' });
 expect(f.frames.filter(x => x.type === 20)).toHaveLength(1); expect(f.frames.filter(x => x.type === 22)).toHaveLength(1);
 expect((await f.lines()).filter(r => r.method === 'turn/interrupt')).toHaveLength(0);
});
it('rejects UI path injection and stale catalogs before any native turn submission', async () => {
 const f = await fixture();
 f.request('path', 'invoke', f.catalog.version, { path: f.path });
 f.request('stale', 'invoke', 'stale-catalog');
 expect(await f.result('path')).toMatchObject({ status: 'failed', error: 'invalid_request' });
 expect(await f.result('stale')).toMatchObject({ status: 'failed', error: 'catalog_stale' });
 expect((await f.lines()).filter(r => r.method === 'turn/start')).toHaveLength(0); expect(f.frames).toEqual([]);
});
