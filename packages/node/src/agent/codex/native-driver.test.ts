import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CodexNativeDriver, codexNativeEnv } from './native-driver.js';
import { CodexAppServer } from './app-server.js';
import { CodexTurnGrants } from './turn-grants.js';
import type { AgentEvent, PreparedRun } from '../events.js';

const script = `
const fs=require('node:fs');
if(process.argv.includes('--version')){console.log('codex-cli 0.142.3');process.exit(0)}
const send=p=>process.stdout.write(JSON.stringify(p)+'\\n');let number=0;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);fs.appendFileSync(process.env.WIRE,JSON.stringify(r)+'\\n');
 if(r.method==='initialize')return send({id:r.id,result:{userAgent:'aichat/0.142.3 (test; 1)'}});
 if(r.method==='initialized')return;
 if(r.method==='thread/start'||r.method==='thread/resume')return send({id:r.id,result:{thread:{id:r.params.threadId||'native-thread',cwd:r.params.cwd,cliVersion:process.env.BAD_CLI||'0.142.3'}}});
 if(r.method==='turn/interrupt')return send({id:r.id,result:{}});
 if(r.method!=='turn/start')return;
 const id='turn-'+(++number),threadId='native-thread';
 send({method:'turn/completed',params:{threadId,turn:{id:'unrelated',status:'completed',items:[]}}});
 if(process.env.FLOOD!=='1')send({id:r.id,result:{turn:{id,status:'inProgress',items:[]}}});
 send({method:'turn/started',params:{threadId,turn:{id,status:'inProgress',items:[]}}});
 if(process.env.FLOOD==='1'){for(let n=0;n<4100;n++)send({method:'item/agentMessage/delta',params:{threadId,turnId:id,itemId:'a',delta:'x'}});send({id:r.id,result:{turn:{id,status:'inProgress',items:[]}}});return;}
 if(process.env.PARK==='1')return;
 setTimeout(()=>{
  send({method:'item/started',params:{threadId,turnId:id,item:{id:'exec-1',type:'commandExecution',command:'not-logged'}}});
  send({method:'item/started',params:{threadId,turnId:id,item:{id:'exec-1',type:'commandExecution'}}});
  send({method:'item/agentMessage/delta',params:{threadId:'foreign-child',turnId:id,itemId:'a',delta:'must-not-leak'}});
  send({method:'item/agentMessage/delta',params:{threadId,turnId:id,itemId:'a',delta:'visible'}});
  send({method:'item/completed',params:{threadId,turnId:id,item:{id:'exec-1',type:'commandExecution'}}});
  send({method:'turn/completed',params:{threadId,turn:{id,status:'completed',items:[]}}});
 },30);
});
`;
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of disposers.splice(0).reverse()) await dispose(); });
async function fixture(extra: NodeJS.ProcessEnv = {}) {
	const directory = await mkdtemp(join(tmpdir(), 'aichat-native-507-'));
	const file = join(directory, 'native.cjs'), wire = join(directory, 'wire.jsonl');
	await writeFile(file, script);
	const grants = await CodexTurnGrants.create();
	const channels: CodexAppServer[] = [];
	const driver = new CodexNativeDriver({ command: 'unused', env: { ...process.env, WIRE: wire, ...extra }, createGrants: async () => grants,
		createChannel: (args, env) => { const channel = new CodexAppServer({ command: process.execPath, prefix: [file], args, env, timeoutMs: 2000 }); channels.push(channel); return channel; } });
	let state: unknown;
	let current = true;
	const onNativeBound = vi.fn();
	const input: PreparedRun = { runId: 'request-1', message: 'pure user input', workspace: directory, systemPrompt: 'frozen persona',
		replyToken: 'secret-token', replyThinkingId: 'thinking-1', signal: new AbortController().signal, capabilities: { async invoke() {} },
		saveRecovery: async () => {}, onNativeBound,
		conversation: { id: 'conversation-1', generation: 1, get nativeState() { return state === undefined ? undefined : { version: 1, value: state }; },
			assertCurrent() { if (!current) throw new Error('stale generation'); },
			async saveNativeState(value) { state = value.value; }, async registerNative(_id, value) { state = value.value; }, async registerNativeAlias() {} } };
	disposers.push(async () => { await driver.disconnect(); await rm(grants.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
		await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
	return { driver, grants, channels, input, onNativeBound, setCurrent(value: boolean) { current = value; }, get state() { return state; },
		wire: async () => (await readFile(wire, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)) };
}
async function collect(events: AsyncIterable<AgentEvent>) { const result: AgentEvent[] = []; for await (const event of events) result.push(event); return result; }

describe('Codex persistent native ordinary-message vertical', () => {
	it('keeps one native process/thread, exact turn IDs, immutable per-turn grants, and root event dedup', async () => {
		const f = await fixture();
		const first = await collect(f.driver.createRun(f.input).events);
		expect(first).toEqual([{ type: 'tool', name: 'commandExecution', phase: 'start' }, { type: 'thinking', text: 'visible' },
			{ type: 'tool', name: 'commandExecution', phase: 'end' }, { type: 'done', durationMs: expect.any(Number) }]);
		expect(f.state).toMatchObject({ threadId: 'native-thread', workspace: f.input.workspace, nativeControls: true });
		expect(f.onNativeBound.mock.calls[0][0]).toEqual({ sessionId: 'native-thread', turnId: 'turn-1' });
		const id = createHash('sha256').update(JSON.stringify(['native-thread', 'turn-1'])).digest('hex');
		expect(await readFile(join(f.grants.directory, `${id}.env`), 'utf8')).toContain("'secret-token'");
		expect(await readFile(join(f.grants.directory, `${id}.revoked`), 'utf8')).toBe('');
		await collect(f.driver.createRun({ ...f.input, runId: 'request-2', replyToken: 'next-token', replyThinkingId: 'thinking-2' }).events);
		const wire = await f.wire();
		expect(wire.filter((r) => r.method === 'initialize')).toHaveLength(1);
		expect(wire.filter((r) => r.method === 'thread/start')).toHaveLength(1);
		expect(wire.filter((r) => r.method === 'turn/start').map((r) => r.params)).toEqual([
			{ threadId: 'native-thread', clientUserMessageId: 'request-1', input: [{ type: 'text', text: 'pure user input', text_elements: [] }] },
			{ threadId: 'native-thread', clientUserMessageId: 'request-2', input: [{ type: 'text', text: 'pure user input', text_elements: [] }] },
		]);
		expect(JSON.stringify(wire)).not.toContain('secret-token');
		expect(await readFile(join(f.grants.directory, `${id}.env`), 'utf8')).not.toContain('next-token');
	});
	it('cannot admit a native run before exact START-ready reply target exists', async () => {
		const f = await fixture();
		const run = f.driver.createRun({ ...f.input, replyThinkingId: undefined });
		expect(await collect(run.events)).toEqual([{ type: 'error', message: expect.stringContaining('START-ready') }]);
		await expect(f.wire()).rejects.toMatchObject({ code: 'ENOENT' });
	});
	it('may be constructed before START, but consumes native input only after the core fixes that exact run', async () => {
		const f = await fixture();
		f.input.replyThinkingId = undefined;
		const run = f.driver.createRun(f.input);
		await expect(f.wire()).rejects.toMatchObject({ code: 'ENOENT' });
		f.input.replyThinkingId = 'exact-start-ready';
		expect((await collect(run.events)).at(-1)?.type).toBe('done');
	});
	it('preserves the old generation/persona gate before any native mutation', async () => {
		const f = await fixture();
		f.setCurrent(false);
		expect(await collect(f.driver.createRun(f.input).events)).toEqual([{ type: 'error', message: 'stale generation' }]);
		await expect(f.wire()).rejects.toMatchObject({ code: 'ENOENT' });
	});
	it('does not silently resume legacy threads with unverified original cwd/persona', async () => {
		const f = await fixture();
		await f.input.conversation.saveNativeState({ version: 1, value: { threadId: 'legacy' } });
		expect(await collect(f.driver.createRun(f.input).events)).toEqual([{ type: 'error', message: expect.stringContaining('CODEX_LEGACY_THREAD_UNVERIFIED') }]);
		await expect(f.wire()).rejects.toMatchObject({ code: 'ENOENT' });
	});
	it('refuses thread response version drift before turn submission', async () => {
		const f = await fixture({ BAD_CLI: '0.142.4' });
		expect(await collect(f.driver.createRun(f.input).events)).toEqual([{ type: 'error', message: 'CODEX_NATIVE_THREAD_UNVERIFIED' }]);
		expect((await f.wire()).some((r) => r.method === 'turn/start')).toBe(false);
	});
	it('revokes the exact native turn and interrupts without inventing process-tree stop proof', async () => {
		const f = await fixture({ PARK: '1' });
		const run = f.driver.createRun(f.input);
		let cancellation: ReturnType<typeof run.cancel> | undefined;
		f.input.onNativeBound = (ref) => { f.onNativeBound(ref); cancellation = run.cancel('user stop'); };
		expect(await collect(run.events)).toEqual([{ type: 'cancelled', reason: 'Codex native stop unconfirmed' }]);
		expect(await cancellation).toMatchObject({ status: 'unconfirmed' });
		expect(await run.cancel('repeat')).toMatchObject({ status: 'unconfirmed' });
		await run.dispose();
		expect((await f.wire()).filter((r) => r.method === 'turn/interrupt').map((r) => r.params))
			.toEqual([{ threadId: 'native-thread', turnId: 'turn-1' }]);
		const id = createHash('sha256').update(JSON.stringify(['native-thread', 'turn-1'])).digest('hex');
		expect(await readFile(join(f.grants.directory, `${id}.revoked`), 'utf8')).toBe('');
		await expect(readFile(join(f.grants.directory, `${id}.env`), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
	});
	it('revocation IO failure cannot short-circuit interrupt, wake or the unconfirmed stop result', async () => {
		const f = await fixture({ PARK: '1' });
		const run = f.driver.createRun(f.input);
		vi.spyOn(f.grants, 'revoke').mockRejectedValue(new Error('injected disk full'));
		let cancellation: ReturnType<typeof run.cancel> | undefined;
		f.input.onNativeBound = () => { cancellation = run.cancel('user stop'); };
		expect(await collect(run.events)).toEqual([{ type: 'cancelled', reason: 'Codex native stop unconfirmed' }]);
		expect(await cancellation).toMatchObject({ status: 'unconfirmed', reason: expect.stringContaining('CODEX_GRANT_REVOKE_FAILED') });
		expect((await f.wire()).filter((r) => r.method === 'turn/interrupt')).toHaveLength(1);
		await expect(f.channels[0].request('thread/read', { threadId: 'native-thread' })).rejects.toThrow('CODEX_CHANNEL_CLOSED');
	});
	it('disconnect closes its real channel even if lifetime revocation IO fails, while surfacing that failure', async () => {
		const f = await fixture();
		await collect(f.driver.createRun(f.input).events);
		vi.spyOn(f.grants, 'revokeAll').mockRejectedValue(new Error('injected read-only filesystem'));
		await expect(f.driver.disconnect()).rejects.toThrow('injected read-only filesystem');
		await expect(f.channels[0].request('thread/read', { threadId: 'native-thread' })).rejects.toThrow('CODEX_CHANNEL_CLOSED');
	});
	it('admission failure closes its real channel even when its revocation cleanup also fails', async () => {
		const f = await fixture({ BAD_CLI: '0.142.4' });
		vi.spyOn(f.grants, 'revokeAll').mockRejectedValue(new Error('injected read-only filesystem'));
		expect(await collect(f.driver.createRun(f.input).events)).toEqual([{ type: 'error', message: 'injected read-only filesystem' }]);
		await expect(f.channels[0].request('thread/read', { threadId: 'native-thread' })).rejects.toThrow('CODEX_CHANNEL_CLOSED');
	});
	it('abort-triggered cancellation consumes failures and still interrupts when grant IO fails', async () => {
		const f = await fixture({ PARK: '1' });
		const abort = new AbortController(); f.input.signal = abort.signal;
		vi.spyOn(f.grants, 'revoke').mockRejectedValue(new Error('injected disk full'));
		f.input.onNativeBound = () => { abort.abort(); };
		expect(await collect(f.driver.createRun(f.input).events)).toEqual([{ type: 'cancelled', reason: 'Codex native stop unconfirmed' }]);
		expect((await f.wire()).filter((r) => r.method === 'turn/interrupt')).toHaveLength(1);
	});
	it('late native identity from an old generation cannot receive a new usable grant', async () => {
		const f = await fixture();
		f.input.onNativeBound = () => { f.setCurrent(false); };
		expect(await collect(f.driver.createRun(f.input).events)).toEqual([{ type: 'error', message: 'stale generation' }]);
		const id = createHash('sha256').update(JSON.stringify(['native-thread', 'turn-1'])).digest('hex');
		expect(await readFile(join(f.grants.directory, `${id}.revoked`), 'utf8')).toBe('');
		await expect(readFile(join(f.grants.directory, `${id}.env`), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
	});
	it('event overflow is unknown, not a dropped native terminal or invented success', async () => {
		const f = await fixture({ FLOOD: '1' });
		expect(await collect(f.driver.createRun(f.input).events)).toEqual([{ type: 'error', message: 'CODEX_RESULT_UNKNOWN: native event buffer exceeded' }]);
	});
	it('pre-submission cancellation starts neither app-server nor a native turn', async () => {
		const f = await fixture();
		const run = f.driver.createRun(f.input);
		expect(await run.cancel('before')).toEqual({ status: 'stopped' });
		expect(await collect(run.events)).toEqual([{ type: 'cancelled', reason: 'Cancelled before submission' }]);
		await expect(f.wire()).rejects.toMatchObject({ code: 'ENOENT' });
	});
	it('clears inherited aliases and per-run secrets before persistent child launch', () => {
		const env = codexNativeEnv({ PATH: 'needed', HOME: 'home', AICHAT_RUN_BIND: 'old', AICHAT_CONTEXT_KEY: 'wrong-room',
			OPENCODE_SESSION_ID: 'op', CODEX_THREAD_ID: 'old-thread', AICHAT_BIND: 'cc', OPENCLAW_BIND: 'oc', DSH_SESSION_ID: 'dsh', AICHAT_CC_RUN: 'cc-run' });
		expect(env).toEqual({ PATH: 'needed', HOME: 'home', AICHAT_CODEX_NATIVE: '1' });
	});
});
