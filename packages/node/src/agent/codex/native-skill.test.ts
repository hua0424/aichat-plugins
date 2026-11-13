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
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
async function fixture(mode = '') {
 const home = await mkdtemp(join(tmpdir(), 'codex-skill-')), wire = join(home, 'wire'), script = join(home, 'child.cjs'), path = join(home, 'trusted-skill.md');
 await writeFile(path, 'deterministic fake skill');
 await writeFile(script, `const fs=require('node:fs');if(process.argv.includes('--version')){console.log('codex-cli 0.142.3');process.exit(0)}const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');let seq=0;
 require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line),p=r.params||{};fs.appendFileSync(process.env.WIRE,line+'\\n');let result={},deferAck=false;
 if(r.method==='initialize')result={userAgent:'aichat/0.142.3'};
 if(r.method==='config/read')result={config:{model_provider:'openai'}};
 if(r.method==='skills/list')result={data:[{cwd:p.cwds[0],skills:[{name:'probe',scope:'user',path:process.env.SKILL,enabled:true,description:'native'}],errors:[]}]};
 if(r.method==='model/list')result={data:[],nextCursor:null};
 if(r.method==='thread/start'){const n=Number(fs.existsSync(process.env.THREADS)?fs.readFileSync(process.env.THREADS,'utf8'):0)+1;fs.writeFileSync(process.env.THREADS,String(n));result={thread:{id:'thread-'+n,cwd:p.cwd,cliVersion:'0.142.3'}};if(process.env.MODE==='attach-thread-init'&&n===1)deferAck=true;}
 if(r.method==='thread/resume')result={thread:{id:p.threadId,cwd:p.cwd,cliVersion:'0.142.3'}};
 if(r.method==='turn/start'){const n=++seq,id=process.env.MODE==='attach-prewarmed'&&n===1?'seed-turn':process.env.MODE.startsWith('attach')?'turn-1':'turn-'+n;deferAck=process.env.MODE==='attach-late-ack'&&n===1;const fresh=!process.env.MODE.startsWith('attach')||n===1||(process.env.MODE==='attach-prewarmed'&&n===2);result={turn:{id:fresh&&process.env.MODE!=='orphan'?id:'submission-'+n,status:'inProgress',items:[]}};if(fresh&&process.env.MODE!=='no-start')send({method:'turn/started',params:{threadId:p.threadId,turn:{id,status:'inProgress',items:[]}}});
 const proof={method:'item/started',params:{threadId:p.threadId,turnId:id,item:{id:'input-'+n,type:'userMessage',clientId:p.clientUserMessageId,content:p.input}}};
 if(process.env.MODE==='foreign-client')proof.params.item.clientId='unregistered';
 if(process.env.MODE==='foreign-thread')proof.params.threadId='other-thread';
 if(process.env.MODE==='missing')setTimeout(()=>process.exit(0),50);
 else if(['gate','attach-gate'].includes(process.env.MODE)){const gate=setInterval(()=>{if(fs.existsSync(process.env.PROOF)){clearInterval(gate);send(proof);}},5);}
 else {send(proof);if(process.env.MODE==='conflict')send({...proof,params:{...proof.params,turnId:'other-turn'}});if(process.env.MODE==='duplicate')send({...proof,method:'item/completed'});}
 if(['foreign-client','foreign-thread','conflict'].includes(process.env.MODE))setTimeout(()=>process.exit(0),100);
 const poll=setInterval(()=>{if(fs.readdirSync(process.env.GRANTS).some(x=>x.endsWith('.env'))&&((process.env.MODE==='attach-prewarmed'&&n===1)||!(process.env.MODE.startsWith('attach')||process.env.MODE==='separate')||fs.existsSync(process.env.MODE==='attach-old-terminal'&&p.threadId==='thread-2'?process.env.DONE+'-new':process.env.DONE))){clearInterval(poll);if(process.env.MODE==='attach-loss'||(process.env.MODE==='attach-old-loss'&&p.threadId==='thread-1')){process.exit(0);return;}send({method:'item/agentMessage/delta',params:{threadId:p.threadId,turnId:id,itemId:'a',delta:'native answer'}});send({method:'turn/completed',params:{threadId:p.threadId,turn:{id,status:process.env.MODE==='native-failed'?'failed':process.env.MODE==='native-interrupted'?'interrupted':'completed',items:[]}}});}},5);}
 if(r.id){if(deferAck){const gate=setInterval(()=>{if(fs.existsSync(process.env.ACK)){clearInterval(gate);send({id:r.id,result});}},5);}else send({id:r.id,result});}});`);
 const store = new ConversationStore({ home, serverNamespace: 'server', activeUids: new Set(['u']), activeProviders: new Map([['u', 'codex']]) });
 const grants: CodexTurnGrants[] = [];
 const driver = new CodexNativeDriver({ command: 'unused', env: process.env,
  createGrants: async () => { const g = await CodexTurnGrants.create(); grants.push(g); return g; },
  createChannel: (args) => new CodexAppServer({ command: process.execPath, prefix: [script], args, timeoutMs: 3000,
   env: { ...process.env, WIRE: wire, SKILL: path, MODE: mode, GRANTS: grants.at(-1)?.directory, DONE: join(home, 'done'), PROOF: join(home, 'proof'), ACK: join(home, 'ack'), THREADS: join(home, 'threads') } }) });
 let handler!: MessageHandler, ack = true, currentEpoch = 'epoch';
 const frames: Array<{ type: number; data: Record<string, unknown> }> = [], receipts: AgentCommandResponse[] = [];
 const send = vi.fn((type: number, data: Record<string, unknown>) => { frames.push({ type, data }); if (type === 20 && mode === 'start-fail') throw new Error('START transport failed'); if (type === 20 && ack) queueMicrotask(() => handler.handle({ type: 'thinkingStart', data: { ...data, fromUid: 'u', thinkingId: 'thinking-' + data.clientRunId } })); });
 const report = vi.fn(async (value: AgentCommandResponse) => { receipts.push(value); });
 handler = new MessageHandler({ send, isConnected: true } as unknown as HulaWSClient, driver, 'u', { reportAgentCommandResult: report, sendMessage: async () => ({ id: 'notice' }), listSelfGroupConfigs: async () => [{ roomId: 'room', approved: 1, authorizationEpoch: currentEpoch }] } as unknown as HulaApiClient,
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
  async setEpoch(epoch: string) { currentEpoch = epoch; await handler.prewarmGroupConfigs(); },
  rejectStart(index = 0) { const frame = frames.filter(x => x.type === 20)[index]; handler.handle({ type: 'thinkingEnd', data: { ...frame.data, fromUid: 'u', thinkingId: 'thinking-' + frame.data.clientRunId, status: 'error', error: 'authorization_revoked' } }); },
 ordinary(id = 'ordinary') { handler.handle({ type: 'receiveMessage', data: { fromUser: { uid: 'owner', name: 'Owner', userType: 1 }, message: { id, roomId: 'room', type: 1, roomType: 2, aiclaw: { isOwner: true }, body: { content: 'hello' } } } }); }, setAck(value: boolean) { ack = value; }, ackStart(index = -1) { const data = frames.filter(f => f.type === 20).at(index)!.data; handler.handle({ type: 'thinkingStart', data: { ...data, fromUid: 'u', thinkingId: 'thinking-' + data.clientRunId } }); } };
}
it('times out only the original ordinary resource owner after the existing five-minute budget', async () => {
 const f = await fixture('attach'), create = f.driver.createNativeInput.bind(f.driver), signals: AbortSignal[] = [];
 vi.spyOn(f.driver, 'createNativeInput').mockImplementation(input => { signals.push(input.signal); return create(input); });
 vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
 f.ordinary('owner'); await f.grantPath(); f.ordinary('borrower');
 await waitFor(async () => { const inputs = (await f.lines()).filter(r => r.method === 'turn/start'); expect(inputs).toHaveLength(2);
  expect(f.store.getControl('u', 'room', inputs[1].params.clientUserMessageId)?.receipt?.status).toBe('accepted'); });
 await vi.advanceTimersByTimeAsync(300_001);
 expect(signals.map(signal => signal.aborted)).toEqual([true, false]);
 await waitFor(async () => expect((await f.lines()).filter(r => r.method === 'turn/interrupt')).toHaveLength(1));
 expect(f.frames.filter(x => x.type === 22)).toHaveLength(1);
 expect(f.frames.find(x => x.type === 22)?.data.error).toBe('thinking_session_timeout');
 expect(f.store.get('u', 'room')!.state).toBe('stop_unconfirmed');
 await writeFile(join(f.home, 'done'), '1');
 await waitFor(() => expect(f.store.pendingRuns('u', 'room')).toHaveLength(0));
 expect(f.frames.filter(x => x.type === 22)).toHaveLength(1);
});
it('clears a normally settled ordinary owner budget before it can abort a completed task', async () => {
 const f = await fixture(), create = f.driver.createNativeInput.bind(f.driver); let signal!: AbortSignal;
 vi.spyOn(f.driver, 'createNativeInput').mockImplementation(input => { signal = input.signal; return create(input); });
 vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
 const timers = vi.fn(globalThis.setTimeout), cleared = vi.fn(globalThis.clearTimeout);
  vi.stubGlobal('setTimeout', timers); vi.stubGlobal('clearTimeout', cleared);
 f.ordinary(); await waitFor(() => expect(f.store.pendingRuns('u', 'room')).toHaveLength(0));
 await waitFor(() => expect(f.frames.filter(x => x.type === 22)).toHaveLength(1));
 const budget = timers.mock.results[timers.mock.calls.findIndex(call => call[1] === 300_000)]?.value;
 expect(budget).toBeDefined(); expect(cleared.mock.calls.some(call => call[0] === budget)).toBe(true);
 await vi.advanceTimersByTimeAsync(300_001); expect(signal.aborted).toBe(false);
 expect((await f.lines()).filter(r => r.method === 'turn/interrupt')).toHaveLength(0);
});
it('gives neither a capability owner nor its ordinary borrower an ordinary watchdog', async () => {
 const f = await fixture('attach'), create = f.driver.createNativeInput.bind(f.driver); let signal!: AbortSignal;
 vi.spyOn(f.driver, 'createNativeInput').mockImplementation(input => { signal = input.signal; return create(input); });
 vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); const timers = vi.fn(globalThis.setTimeout);
  vi.stubGlobal('setTimeout', timers);
 f.request('cap-owner', 'invoke', f.catalog.version); await f.grantPath(); f.ordinary('borrower');
 await waitFor(async () => { const input = (await f.lines()).filter(r => r.method === 'turn/start')[1]; expect(input).toBeDefined();
  expect(f.store.getControl('u', 'room', input.params.clientUserMessageId)?.receipt?.status).toBe('accepted'); });
 expect(timers.mock.calls.filter(call => call[1] === 300_000)).toHaveLength(0);
 await vi.advanceTimersByTimeAsync(300_001); expect(signal.aborted).toBe(false);
 expect((await f.lines()).filter(r => r.method === 'turn/interrupt')).toHaveLength(0);
 await writeFile(join(f.home, 'done'), '1'); expect((await f.result('cap-owner')).status).toBe('completed');
 expect(f.frames.filter(x => x.type === 22)).toHaveLength(1);
});
it('clears the reset owner budget while its late terminal cannot clear the new owner budget', async () => {
 const f = await fixture('attach-old-terminal'), create = f.driver.createNativeInput.bind(f.driver), signals: AbortSignal[] = [];
 vi.spyOn(f.driver, 'createNativeInput').mockImplementation(input => { signals.push(input.signal); return create(input); });
 vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
 const timers = vi.fn(globalThis.setTimeout), cleared = vi.fn(globalThis.clearTimeout);
  vi.stubGlobal('setTimeout', timers); vi.stubGlobal('clearTimeout', cleared);
 f.ordinary('old'); await f.grantPath();
 const oldBudget = timers.mock.results[timers.mock.calls.findIndex(call => call[1] === 300_000)]?.value;
 await vi.advanceTimersByTimeAsync(120_000);
 f.request('reset', 'invoke', f.catalog.version, {}, 'session.reset'); expect((await f.result('reset')).status).toBe('completed');
 expect(oldBudget).toBeDefined(); expect(cleared.mock.calls.some(call => call[0] === oldBudget)).toBe(true);
 f.ordinary('new'); await waitFor(async () => expect((await readdir(f.grants[1].directory)).filter(x => x.endsWith('.env'))).toHaveLength(1));
 await writeFile(join(f.home, 'done'), '1'); await waitFor(() => expect(f.frames.filter(x => x.type === 22)).toHaveLength(1));
 await vi.advanceTimersByTimeAsync(180_001); expect(signals.map(s => s.aborted)).toEqual([false, false]);
 await vi.advanceTimersByTimeAsync(120_001); expect(signals.map(s => s.aborted)).toEqual([false, true]);
 await waitFor(async () => expect((await f.lines()).filter(r => r.method === 'turn/interrupt')).toHaveLength(1));
 expect((await f.lines()).find(r => r.method === 'turn/interrupt').params.threadId).toBe('thread-2');
 expect(f.frames.filter(x => x.type === 22)).toHaveLength(2);
});
it('shares the exact first native initialization between two new-room ordinary inputs', async () => {
 const f = await fixture('attach-thread-init'), create = f.driver.createNativeInput.bind(f.driver); let inputs = 0, staleSecondScope = false;
 vi.spyOn(f.driver, 'createNativeInput').mockImplementation(input => {
  const second = ++inputs === 2;
  return create({ ...input, execution: { ...input.execution, conversation: { ...input.execution.conversation,
   get nativeState() { const state = input.execution.conversation.nativeState; if (second && !state) staleSecondScope = true; return state; }
  } } });
 });
 f.ordinary('first'); await waitFor(async () => expect((await f.lines()).filter(r => r.method === 'thread/start')).toHaveLength(1));
 f.ordinary('second'); await waitFor(() => expect(staleSecondScope).toBe(true));
 await writeFile(join(f.home, 'ack'), '1');
 await waitFor(async () => expect((await f.lines()).filter(r => r.method === 'turn/start')).toHaveLength(2));
 expect((await f.lines()).filter(r => r.method === 'thread/start')).toHaveLength(1);
 expect(f.frames.filter(x => x.type === 20)).toHaveLength(1);
 await writeFile(join(f.home, 'done'), '1'); await waitFor(() => expect(f.frames.filter(x => x.type === 22)).toHaveLength(1));
 expect((await f.lines()).filter(r => r.method === 'turn/interrupt')).toHaveLength(0);
});
it.each(['workspace', 'prompt'])('refuses a concurrent first-room input with a different %s instead of borrowing initialization', async fault => {
 const f = await fixture('attach-thread-init'), create = f.driver.createNativeInput.bind(f.driver); let inputs = 0, staleSecondScope = false;
 vi.spyOn(f.driver, 'createNativeInput').mockImplementation(input => {
  const second = ++inputs === 2;
  return create({ ...input, ...(second && fault === 'workspace' ? { workspace: join(f.home, 'other-cwd') } : {}), execution: { ...input.execution,
   ...(second && fault === 'prompt' ? { systemPrompt: 'different frozen developer instructions' } : {}),
   conversation: { ...input.execution.conversation, get nativeState() {
    const state = input.execution.conversation.nativeState; if (second && !state) staleSecondScope = true; return state;
   } }
  } });
 });
 f.ordinary('first'); await waitFor(async () => expect((await f.lines()).filter(r => r.method === 'thread/start')).toHaveLength(1));
 f.ordinary('second'); await waitFor(() => expect(staleSecondScope).toBe(true)); await writeFile(join(f.home, 'ack'), '1');
 await f.grantPath(); await waitFor(() => expect(f.store.get('u', 'room')!.controls?.some(control =>
  control.receipt?.status === 'failed' && control.receipt.error?.includes('CODEX_NATIVE_SCOPE_CHANGED'))).toBe(true));
 expect((await f.lines()).filter(r => r.method === 'turn/start')).toHaveLength(1);
 expect((await f.lines()).filter(r => r.method === 'thread/start')).toHaveLength(1);
 await writeFile(join(f.home, 'done'), '1'); await waitFor(() => expect(f.frames.filter(x => x.type === 22)).toHaveLength(1));
 expect((await f.lines()).filter(r => r.method === 'turn/interrupt')).toHaveLength(0);
});
it('does not borrow a reset successor for ordinary inputs awaiting their first initialization', async () => {
 const f = await fixture('attach-thread-init'), create = f.driver.createNativeInput.bind(f.driver); let inputs = 0, staleSecondScope = false;
 vi.spyOn(f.driver, 'createNativeInput').mockImplementation(input => {
  const second = ++inputs === 2;
  return create({ ...input, execution: { ...input.execution, conversation: { ...input.execution.conversation,
   get nativeState() { const state = input.execution.conversation.nativeState; if (second && !state) staleSecondScope = true; return state; }
  } } });
 });
 f.ordinary('first'); await waitFor(async () => expect((await f.lines()).filter(r => r.method === 'thread/start')).toHaveLength(1));
 const generation = f.store.get('u', 'room')!.generation;
 f.ordinary('second'); await waitFor(() => expect(staleSecondScope).toBe(true));
 f.request('reset', 'invoke', f.catalog.version, {}, 'session.reset');
 await waitFor(() => expect(f.store.get('u', 'room')!.generation).toBe(generation + 1));
 await writeFile(join(f.home, 'ack'), '1'); expect((await f.result('reset')).status).toBe('completed');
 expect((await f.lines()).filter(r => r.method === 'turn/start')).toHaveLength(0);
 f.ordinary('fresh'); await waitFor(async () => expect((await f.lines()).filter(r => r.method === 'turn/start')).toHaveLength(1));
 expect((await f.lines()).find(r => r.method === 'turn/start').params.threadId).toBe('thread-2');
 await writeFile(join(f.home, 'done'), '1'); await waitFor(() => expect(f.frames.filter(x => x.type === 22)).toHaveLength(1));
 expect((await f.lines()).filter(r => r.method === 'thread/start')).toHaveLength(2);
 expect((await f.lines()).filter(r => r.method === 'turn/interrupt')).toHaveLength(0);
});
it('admits ordinary input before proof without minting a reply token or START', async () => {
 const f = await fixture('gate'), mint = vi.spyOn(f.store, 'beginRun');
 f.ordinary();
 await waitFor(async () => expect((await f.lines()).filter(r => r.method === 'turn/start')).toHaveLength(1));
 expect(mint).not.toHaveBeenCalled(); expect(f.frames.filter(x => x.type === 20)).toHaveLength(0);
 expect(f.store.get('u', 'room')!.replyBindings ?? []).toHaveLength(0);
 await writeFile(join(f.home, 'proof'), '1');
 await waitFor(() => expect(f.frames.filter(x => x.type === 22)).toHaveLength(1));
 expect(mint).toHaveBeenCalledTimes(1);
});
it('does not authorize a frozen ordinary proof after its current epoch changes', async () => {
 const f = await fixture('gate'), mint = vi.spyOn(f.store, 'beginRun'); f.ordinary();
 await waitFor(async () => expect((await f.lines()).filter(r => r.method === 'turn/start')).toHaveLength(1));
 await f.setEpoch('next-epoch'); await writeFile(join(f.home, 'proof'), '1');
 await waitFor(async () => { const request = (await f.lines()).find(r => r.method === 'turn/start');
  expect(f.store.getControl('u', 'room', request.params.clientUserMessageId)?.receipt?.status).toBe('unknown'); });
 expect(mint).not.toHaveBeenCalled(); expect(f.frames.filter(x => x.type === 20)).toHaveLength(0);
 expect((await readdir(f.grants[0].directory)).filter(x => x.endsWith('.env'))).toHaveLength(0);
 expect((await f.lines()).filter(r => r.method === 'turn/interrupt')).toHaveLength(0);
});
it.each(['orphan', 'no-start', 'missing', 'foreign-client', 'foreign-thread', 'conflict'])('leaves ordinary %s origin unknown without mint, START or interrupt', async mode => {
 const f = await fixture(mode), mint = vi.spyOn(f.store, 'beginRun'), mark = vi.spyOn(f.store, 'markStopUnconfirmed'); f.ordinary();
 await waitFor(async () => { const request = (await f.lines()).find(r => r.method === 'turn/start'); expect(request).toBeDefined();
  expect(f.store.getControl('u', 'room', request.params.clientUserMessageId)?.receipt?.status).toBe('unknown'); });
 expect(mint).not.toHaveBeenCalled(); expect(f.frames.filter(x => x.type === 20)).toHaveLength(0);
 expect((await readdir(f.grants[0].directory)).filter(x => x.endsWith('.env'))).toHaveLength(0);
 expect((await f.lines()).filter(r => r.method === 'turn/start')).toHaveLength(1);
 expect((await f.lines()).filter(r => r.method === 'turn/interrupt')).toHaveLength(0); expect(mark).not.toHaveBeenCalled();
});
it('marks only the actual ordinary owner stop-unconfirmed after grant then channel loss', async () => {
 const f = await fixture('attach-loss'), mark = vi.spyOn(f.store, 'markStopUnconfirmed'); f.ordinary('owner');
 await f.grantPath(); f.ordinary('borrower');
 await waitFor(async () => { const turns = (await f.lines()).filter(r => r.method === 'turn/start'); expect(turns).toHaveLength(2);
  expect(f.store.getControl('u', 'room', turns[1].params.clientUserMessageId)?.receipt?.status).toBe('accepted'); });
 const lifecycle = f.store.get('u', 'room')!.pendingRuns![0].runId;
 await writeFile(join(f.home, 'done'), '1');
 await waitFor(async () => { for (const r of (await f.lines()).filter(r => r.method === 'turn/start'))
  expect(f.store.getControl('u', 'room', r.params.clientUserMessageId)?.receipt?.status).toBe('unknown'); });
 expect(f.store.get('u', 'room')!.state).toBe('stop_unconfirmed');
 expect(mark.mock.calls).toEqual([[lifecycle]]); expect(f.store.get('u', 'room')!.pendingRuns).toHaveLength(1);
 expect(f.frames.filter(x => x.type === 22)).toHaveLength(0);
 f.ordinary('blocked'); await new Promise(resolve => setTimeout(resolve, 30));
 expect((await f.lines()).filter(r => r.method === 'turn/start')).toHaveLength(2);
 expect((await f.lines()).filter(r => r.method === 'turn/interrupt')).toHaveLength(0);
});
it('never replays a completed ordinary input after disposal fails', async () => {
 const f = await fixture(), create = f.driver.createNativeInput.bind(f.driver), send = f.send.getMockImplementation()!;
 let disposed = false, next = false;
 f.send.mockImplementation((type, data) => { send(type, data); if (type === 22 && !next) { next = true; f.ordinary('next'); } });
 vi.spyOn(f.driver, 'createNativeInput').mockImplementationOnce(input => {
  const run = create(input), dispose = run.dispose.bind(run);
  vi.spyOn(run, 'dispose').mockImplementation(async () => { await dispose(); disposed = true; throw new Error('injected disposal failure'); });
  return run;
 });
 f.ordinary('first'); await waitFor(() => expect(disposed).toBe(true));
 const first = (await f.lines()).find(r => r.method === 'turn/start');
 expect(f.store.getControl('u', 'room', first.params.clientUserMessageId)?.receipt?.status).toBe('completed');
 await waitFor(() => expect(f.frames.filter(x => x.type === 22).length).toBeGreaterThanOrEqual(2));
 await new Promise(resolve => setTimeout(resolve, 60));
 expect((await f.lines()).filter(r => r.method === 'turn/start')).toHaveLength(2);
 expect(f.store.getControl('u', 'room', first.params.clientUserMessageId)?.receipt?.status).toBe('completed');
 expect((await f.lines()).filter(r => r.method === 'turn/interrupt')).toHaveLength(0);
});
it('records an unsubmitted native construction fault without inventing an owner or replay', async () => {
 const f = await fixture(), prepared = vi.spyOn(f.store, 'prepareControl'), mark = vi.spyOn(f.store, 'markStopUnconfirmed');
 vi.spyOn(f.driver, 'createNativeInput').mockImplementationOnce(() => { throw new Error('injected construction failure'); });
 f.ordinary('unsubmitted'); await waitFor(() => expect(prepared).toHaveBeenCalledTimes(1));
 const id = prepared.mock.calls[0][2];
 await waitFor(() => expect(f.store.getControl('u', 'room', id)?.receipt?.status).toBe('unknown'));
 expect((await f.lines()).filter(r => r.method === 'turn/start')).toHaveLength(0);
 expect(f.store.get('u', 'room')!.pendingRuns ?? []).toHaveLength(0); expect(f.frames.filter(x => x.type === 20)).toHaveLength(0);
 f.ordinary('fresh'); await waitFor(() => expect(f.frames.filter(x => x.type === 22)).toHaveLength(1));
 await new Promise(resolve => setTimeout(resolve, 60));
 expect((await f.lines()).filter(r => r.method === 'turn/start')).toHaveLength(1);
 expect(mark).not.toHaveBeenCalled(); expect((await f.lines()).filter(r => r.method === 'turn/interrupt')).toHaveLength(0);
});
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
it.each([
 ['ordinary', 'ordinary', 'attach'], ['ordinary', 'skill', 'attach'], ['skill', 'ordinary', 'attach'],
 ['ordinary', 'ordinary', 'attach-late-ack'], ['ordinary', 'skill', 'attach-late-ack'], ['skill', 'ordinary', 'attach-late-ack'],
 ['ordinary', 'ordinary', 'attach-recovery-pause'], ['ordinary', 'skill', 'attach-recovery-pause'], ['skill', 'ordinary', 'attach-recovery-pause'],
])('keeps one original lease for %s then %s with %s', async (firstKind, secondKind, mode) => {
 const f = await fixture(mode), mint = vi.spyOn(f.store, 'beginRun');
 let resume!: () => void, paused = false;
 const gate = new Promise<void>(resolve => { resume = resolve; });
 if (mode === 'attach-recovery-pause') {
  if (firstKind === 'ordinary') {
   const create = f.driver.createNativeInput.bind(f.driver);
   vi.spyOn(f.driver, 'createNativeInput').mockImplementation(input => create({ ...input, execution: { ...input.execution, saveRecovery: async value => {
    if ((value.value as { nativeRef?: unknown }).nativeRef) { paused = true; await gate; }
    await input.execution.saveRecovery(value);
   } } }));
  } else {
   const invoke = f.driver.executeCapability.bind(f.driver);
   vi.spyOn(f.driver, 'executeCapability').mockImplementation(input => invoke({ ...input, execution: input.execution && { ...input.execution, saveRecovery: async value => {
    if ((value.value as { nativeRef?: unknown }).nativeRef) { paused = true; await gate; }
    await input.execution!.saveRecovery(value);
   } } }));
  }
 }
 const send = (kind: string, id: string) => kind === 'ordinary' ? f.ordinary(id) : f.request(id, 'invoke', f.catalog.version);
 send(firstKind, 'first');
 await waitFor(async () => expect((await f.lines()).filter(r => r.method === 'turn/start')).toHaveLength(1));
 if (mode === 'attach-recovery-pause') await waitFor(() => expect(paused).toBe(true));
 if (mode === 'attach') await f.grantPath();
 else { expect(mint).not.toHaveBeenCalled(); expect(f.frames.filter(frame => frame.type === 20)).toHaveLength(0); }
 const grant = vi.spyOn(f.grants[0], 'grant'), revoke = vi.spyOn(f.grants[0], 'revoke');
 send(secondKind, 'second');
 await waitFor(async () => expect((await f.lines()).filter(r => r.method === 'turn/start')).toHaveLength(2));
 resume(); await writeFile(join(f.home, 'ack'), '1');
 await waitFor(async () => { const requests = (await f.lines()).filter(r => r.method === 'turn/start');
  expect(requests.map(r => f.store.getControl('u', 'room', r.params.clientUserMessageId)?.receipt?.status)).toEqual(['accepted', 'accepted']); });
 const env = await f.grantPath(), token = await readFile(env, 'utf8');
 expect(mint).toHaveBeenCalledTimes(1); expect(f.frames.filter(frame => frame.type === 20)).toHaveLength(1);
 expect(grant).toHaveBeenCalledTimes(mode === 'attach' ? 0 : 1); expect(revoke).not.toHaveBeenCalled();
 await writeFile(join(f.home, 'done'), '1');
 await waitFor(() => expect(f.frames.filter(frame => frame.type === 22)).toHaveLength(1));
 expect(await readFile(env, 'utf8')).toBe(token);
 expect((await f.lines()).filter(r => r.method === 'turn/interrupt')).toHaveLength(0);
});
it('cancels only the real ordinary owner resource, never its borrowed observer', async () => {
 const f = await fixture('attach'), create = vi.spyOn(f.driver, 'createNativeInput'); f.ordinary(); await f.grantPath();
 const original = vi.spyOn(create.mock.results[0].value, 'cancel'); f.ordinary('attached');
 await waitFor(async () => { const requests = (await f.lines()).filter(r => r.method === 'turn/start'); expect(requests).toHaveLength(2);
  expect(f.store.getControl('u', 'room', requests[1].params.clientUserMessageId)?.receipt?.status).toBe('accepted'); });
 const borrowed = vi.spyOn(create.mock.results[1].value, 'cancel'); f.rejectStart();
 await waitFor(async () => expect((await f.lines()).filter(r => r.method === 'turn/interrupt')).toHaveLength(1));
 expect(original).toHaveBeenCalled(); expect(borrowed).not.toHaveBeenCalled();
 expect((await readdir(f.grants[0].directory)).filter(x => x.endsWith('.revoked'))).toHaveLength(1);
});
it('settles an already-granted ordinary old lease without changing the new generation owner', async () => {
 const f = await fixture('attach'), mint = vi.spyOn(f.store, 'beginRun'); f.ordinary();
 const oldEnv = await f.grantPath(), token = await readFile(oldEnv, 'utf8');
 f.request('reset', 'invoke', f.catalog.version, {}, 'session.reset'); expect((await f.result('reset')).status).toBe('completed');
 f.ordinary('fresh');
 await waitFor(async () => expect((await readdir(f.grants[1].directory)).filter(x => x.endsWith('.env'))).toHaveLength(1));
 expect(await readFile(oldEnv, 'utf8')).toBe(token); expect(mint).toHaveBeenCalledTimes(2);
 expect(f.frames.filter(x => x.type === 20)).toHaveLength(2);
 await writeFile(join(f.home, 'done'), '1');
 await waitFor(() => expect(f.frames.filter(x => x.type === 22)).toHaveLength(2));
 expect(f.store.get('u', 'room')!.nativeState.codex.threadId).toBe('thread-2');
 expect((await f.lines()).filter(r => r.method === 'turn/interrupt')).toHaveLength(0);
});
it('does not let an old-generation unknown owner pause its reset successor', async () => {
 const f = await fixture('attach-old-loss'), mark = vi.spyOn(f.store, 'markStopUnconfirmed'); f.ordinary(); await f.grantPath();
 const old = (await f.lines()).find(r => r.method === 'turn/start').params.clientUserMessageId;
 f.request('reset', 'invoke', f.catalog.version, {}, 'session.reset'); expect((await f.result('reset')).status).toBe('completed');
 f.ordinary('fresh'); await waitFor(async () => expect((await readdir(f.grants[1].directory)).filter(x => x.endsWith('.env'))).toHaveLength(1));
 await writeFile(join(f.home, 'done'), '1');
 await waitFor(() => { expect(f.store.getControl('u', 'room', old)?.receipt?.status).toBe('unknown'); expect(f.frames.filter(x => x.type === 22)).toHaveLength(1); });
 expect(f.store.get('u', 'room')).toMatchObject({ state: 'ready', nativeState: { codex: { threadId: 'thread-2' } } });
 expect(mark).not.toHaveBeenCalled(); expect(f.store.get('u', 'room')!.pendingRuns).toHaveLength(1);
 expect((await f.lines()).filter(r => r.method === 'turn/interrupt')).toHaveLength(0);
});
it('does not give an ordinary attachment a new token after its original lease expires', async () => {
 const f = await fixture('attach'), mint = vi.spyOn(f.store, 'beginRun');
 f.ordinary(); const env = await f.grantPath(), token = await readFile(env, 'utf8');
 vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 9 * 24 * 60 * 60 * 1000);
 const grant = vi.spyOn(f.grants[0], 'grant'), revoke = vi.spyOn(f.grants[0], 'revoke'); f.ordinary('late');
 await waitFor(async () => { const requests = (await f.lines()).filter(r => r.method === 'turn/start'); expect(requests).toHaveLength(2);
  expect(f.store.getControl('u', 'room', requests[1].params.clientUserMessageId)?.receipt?.status).toBe('unknown'); });
 expect(mint).toHaveBeenCalledTimes(1); expect(f.frames.filter(frame => frame.type === 20)).toHaveLength(1);
 expect(grant).not.toHaveBeenCalled(); expect(revoke).not.toHaveBeenCalled(); expect(await readFile(env, 'utf8')).toBe(token);
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
it('keeps a preSTART ordinary old-generation proof unknown while a new thread gets its own START', async () => {
 const f = await fixture('attach-gate'), mint = vi.spyOn(f.store, 'beginRun');
 f.ordinary(); await waitFor(async () => expect((await f.lines()).filter(r => r.method === 'turn/start')).toHaveLength(1));
 const old = f.store.get('u', 'room')!; expect(old.replyBindings ?? []).toHaveLength(0);
 f.request('reset', 'invoke', f.catalog.version, {}, 'session.reset'); expect((await f.result('reset')).status).toBe('completed');
 expect(f.store.get('u', 'room')!.generation).toBe(old.generation + 1);
 f.request('fresh', 'invoke', f.catalog.version);
 await waitFor(async () => expect((await f.lines()).filter(r => r.method === 'turn/start')).toHaveLength(2));
 await writeFile(join(f.home, 'proof'), '1');
 await waitFor(() => expect(f.receipts.find(r => r.requestId === 'fresh' && r.status === 'accepted'), JSON.stringify(f.receipts)).toBeDefined());
 expect(mint).toHaveBeenCalledTimes(1); expect(f.frames.filter(frame => frame.type === 20)).toHaveLength(1);
 expect((await readdir(f.grants[0].directory)).filter(p => p.endsWith('.env'))).toHaveLength(0);
 await writeFile(join(f.home, 'done'), '1'); expect(await f.result('fresh')).toMatchObject({ status: 'completed', nativeRef: { sessionId: 'thread-2' } });
 await waitFor(() => expect(f.frames.filter(frame => frame.type === 22)).toHaveLength(1));
 expect((await f.lines()).filter(r => r.method === 'turn/interrupt')).toHaveLength(0);
});
it('never registers a failed ordinary START as native authority for the following skill input', async () => {
 const f = await fixture('start-fail'); f.ordinary();
 await waitFor(() => expect(f.frames.filter(frame => frame.type === 20)).toHaveLength(1));
 expect(f.store.get('u', 'room')!.replyBindings![0].thinkingId).toBeUndefined();
 expect((await f.lines()).filter(r => r.method === 'turn/start')).toHaveLength(1);
 f.request('after-failed-start', 'invoke', f.catalog.version); expect((await f.result('after-failed-start')).status).toBe('unknown');
 expect((await readdir(f.grants[0].directory)).filter(p => p.endsWith('.env'))).toHaveLength(0);
 expect((await f.lines()).filter(r => r.method === 'turn/interrupt')).toHaveLength(0);
});
it('keeps the capability original lease while an ordinary attachment arrives before its START acknowledgment', async () => {
 const f = await fixture('attach'), mint = vi.spyOn(f.store, 'beginRun'); f.setAck(false);
 f.request('cap-first', 'invoke', f.catalog.version);
 await waitFor(() => expect(f.frames.filter(frame => frame.type === 20)).toHaveLength(1));
 const grant = vi.spyOn(f.grants[0], 'grant'), revoke = vi.spyOn(f.grants[0], 'revoke'); f.ordinary();
 await waitFor(async () => expect((await f.lines()).filter(r => r.method === 'turn/start')).toHaveLength(2));
 expect(mint).toHaveBeenCalledTimes(1); expect(f.frames.filter(frame => frame.type === 20)).toHaveLength(1); expect(grant).not.toHaveBeenCalled();
 f.ackStart(); await f.grantPath();
 await waitFor(async () => { const requests = (await f.lines()).filter(r => r.method === 'turn/start');
  expect(f.store.getControl('u', 'room', requests[1].params.clientUserMessageId)?.receipt?.status).toBe('accepted'); });
 expect(grant).toHaveBeenCalledTimes(1); expect(revoke).not.toHaveBeenCalled();
 await writeFile(join(f.home, 'done'), '1'); expect((await f.result('cap-first')).status).toBe('completed');
 await waitFor(() => expect(f.frames.filter(frame => frame.type === 22)).toHaveLength(1));
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
