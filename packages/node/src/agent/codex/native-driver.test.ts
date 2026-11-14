import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CodexNativeDriver, codexNativeEnv } from './native-driver.js';
import { CodexAppServer } from './app-server.js';
import { CodexTurnGrants } from './turn-grants.js';
import type { AgentEvent, PreparedRun } from '../events.js';

const publicationFault = vi.hoisted(() => ({ unlink: undefined as undefined | (() => Promise<void>), revoke: undefined as undefined | (() => Promise<void>) }));
vi.mock('node:fs/promises', async (original) => {
	const fs = await original<typeof import('node:fs/promises')>();
	return { ...fs, writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
		if (String(args[0]).endsWith('.revoked') && publicationFault.revoke) await publicationFault.revoke();
		return fs.writeFile(...args);
	}, unlink: async (...args: Parameters<typeof fs.unlink>) => {
		if (String(args[0]).endsWith('.pending') && publicationFault.unlink) await publicationFault.unlink();
		return fs.unlink(...args);
	} };
});

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
 ++number;const id='turn-'+(process.env.ATTACH==='1'?1:number),threadId='native-thread';
 send({method:'turn/completed',params:{threadId,turn:{id:'unrelated',status:'completed',items:[]}}});
 if(process.env.FLOOD!=='1')send({id:r.id,result:{turn:{id:process.env.DIFFERENT_ACK==='1'?'submission-only':id,status:'inProgress',items:[]}}});
 send({method:'turn/started',params:{threadId,turn:{id,status:'inProgress',items:[]}}});
 const proof={method:'item/started',params:{threadId:process.env.PROOF==='foreign-thread'?'other-thread':threadId,turnId:id,item:{id:'input-'+number,type:'userMessage',clientId:process.env.PROOF==='foreign-client'?'other-input':r.params.clientUserMessageId,content:r.params.input}}};
 if(process.env.PROOF!=='missing')send(proof);
 if(process.env.PROOF==='duplicate')send({...proof,method:'item/completed'});
 if(process.env.PROOF==='conflict')send({...proof,params:{...proof.params,turnId:'another-turn'}});
 if(process.env.PROOF==='conflict-gated'){const gate=setInterval(()=>{if(fs.existsSync(process.env.PROOF_GATE)){clearInterval(gate);send({...proof,params:{...proof.params,turnId:'another-turn'}});}},5);}
 if(process.env.FLOOD==='1'){for(let n=0;n<4100;n++)send({method:'item/agentMessage/delta',params:{threadId,turnId:id,itemId:'a',delta:'x'}});send({id:r.id,result:{turn:{id,status:'inProgress',items:[]}}});return;}
 if(process.env.PARK==='1')return;
 setTimeout(()=>{
  send({method:'item/started',params:{threadId,turnId:id,item:{id:'exec-1',type:'commandExecution',command:'not-logged'}}});
  send({method:'item/started',params:{threadId,turnId:id,item:{id:'exec-1',type:'commandExecution'}}});
  send({method:'item/agentMessage/delta',params:{threadId:'foreign-child',turnId:id,itemId:'a',delta:'must-not-leak'}});
  send({method:'item/agentMessage/delta',params:{threadId,turnId:id,itemId:'a',delta:'visible'}});
  send({method:'item/completed',params:{threadId,turnId:id,item:{id:'exec-1',type:'commandExecution'}}});
  send({method:'turn/completed',params:{threadId,turn:{id,status:'completed',items:[]}}});
   if(process.env.DIFFERENT_ACK==='1'||process.env.PROOF)setTimeout(()=>process.exit(0),100);
 },30);
});
`;
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { publicationFault.unlink = undefined; publicationFault.revoke = undefined; vi.restoreAllMocks(); for (const dispose of disposers.splice(0).reverse()) await dispose(); });
async function fixture(extra: NodeJS.ProcessEnv = {}) {
	const directory = await mkdtemp(join(tmpdir(), 'aichat-native-507-'));
	const file = join(directory, 'native.cjs'), wire = join(directory, 'wire.jsonl');
	await writeFile(file, script);
	const grants = await CodexTurnGrants.create();
	const channels: CodexAppServer[] = [];
	const driver = new CodexNativeDriver({ command: 'unused', env: { ...process.env, WIRE: wire, PROOF_GATE: join(directory, 'proof-gate'), ...extra }, createGrants: async () => grants,
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
	it.each(['recovery', 'publication'])('keeps contradictory proof unknown across the %s await without borrowing cleanup ownership', async (window) => {
		const f = await fixture({ PROOF: 'conflict-gated', PARK: '1' });
		const unrelated = { sessionId: 'native-thread', turnId: 'other-owner' };
		await f.grants.grant(unrelated, 'unrelated-token');
		const grant = vi.spyOn(f.grants, 'grant'), revoke = vi.spyOn(f.grants, 'revoke');
		let release!: () => void, entered!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; }), paused = new Promise<void>((resolve) => { entered = resolve; });
		if (window === 'recovery') f.input.saveRecovery = async (recovery) => {
			if (typeof recovery.value === 'object' && recovery.value !== null && 'nativeRef' in recovery.value) { entered(); await gate; }
		};
		else publicationFault.unlink = async () => { entered(); await gate; };
		const run = f.driver.createRun(f.input), result = collect(run.events);
		await paused;
		const conflict = vi.fn();
		const unsubscribe = f.channels[0].onNotification((method, params) => {
			if (method === 'item/started' && typeof params === 'object' && params !== null && 'turnId' in params && params.turnId === 'another-turn') conflict();
		});
		await writeFile(join(f.input.workspace!, 'proof-gate'), 'go');
		await vi.waitFor(() => expect(conflict).toHaveBeenCalledOnce(), { timeout: 3000 });
		release();
		expect(await result).toEqual([{ type: 'error', message: expect.stringContaining('NATIVE_OUTCOME_UNKNOWN: registered native input association ambiguous') }]);
		unsubscribe(); await run.dispose();
		expect(grant).toHaveBeenCalledTimes(window === 'recovery' ? 0 : 1);
		const id = createHash('sha256').update(JSON.stringify(['native-thread', 'turn-1'])).digest('hex');
		if (window === 'recovery') {
			expect(await readdir(f.grants.directory)).not.toContain(`${id}.env`);
			expect(revoke).not.toHaveBeenCalled();
		} else expect(await readdir(f.grants.directory)).toContain(`${id}.revoked`);
		const original = createHash('sha256').update(JSON.stringify(['native-thread', 'other-owner'])).digest('hex');
		expect(await readFile(join(f.grants.directory, `${original}.env`), 'utf8')).toContain("'unrelated-token'");
		expect(await readdir(f.grants.directory)).not.toContain(`${original}.revoked`);
		expect((await f.wire()).filter((r) => r.method === 'turn/start')).toHaveLength(1);
		expect((await f.wire()).filter((r) => r.method === 'turn/interrupt')).toHaveLength(0);
	});
	it.each([false, true])('rolls back its actual publication on pending unlink failure with cancel-first=%s', async (cancelFirst) => {
		const f = await fixture({ PARK: '1' }), run = f.driver.createRun(f.input);
		let release!: () => void, entered!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; }), published = new Promise<void>((resolve) => { entered = resolve; });
		publicationFault.unlink = async () => { entered(); await gate; throw Object.assign(new Error('pending unlink EACCES'), { code: 'EACCES' }); };
		const result = collect(run.events);
		await published;
		const id = createHash('sha256').update(JSON.stringify(['native-thread', 'turn-1'])).digest('hex');
		expect(await readFile(join(f.grants.directory, `${id}.env`), 'utf8')).toContain("'secret-token'");
		if (cancelFirst) expect(await run.cancel('during publication cleanup')).toMatchObject({ status: 'unconfirmed' });
		release();
		expect(await result).toEqual([{ type: 'error', message: 'NATIVE_OUTCOME_UNKNOWN: pending unlink EACCES' }]);
		await run.dispose();
		expect(await readdir(f.grants.directory)).toContain(`${id}.revoked`);
		expect((await f.wire()).filter((r) => r.method === 'turn/start')).toHaveLength(1);
		expect((await f.wire()).filter((r) => r.method === 'turn/interrupt')).toHaveLength(0);
	});
	it.each([false, true])('retains actual publication ownership when rollback also fails with cancel-first=%s', async (cancelFirst) => {
		const f = await fixture({ PARK: '1' }), run = f.driver.createRun(f.input);
		let release!: () => void, entered!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; }), published = new Promise<void>((resolve) => { entered = resolve; });
		publicationFault.unlink = async () => { entered(); await gate; throw Object.assign(new Error('pending unlink EACCES'), { code: 'EACCES' }); };
		let attempts = 0;
		publicationFault.revoke = async () => { if (++attempts === 1) throw Object.assign(new Error('rollback EACCES'), { code: 'EACCES' }); };
		const result = collect(run.events);
		await published;
		if (cancelFirst) await run.cancel('during publication cleanup');
		release();
		expect(await result).toEqual([{ type: 'error', message: 'NATIVE_OUTCOME_UNKNOWN: CODEX_GRANT_ROLLBACK_UNCONFIRMED' }]);
		await run.dispose();
		const id = createHash('sha256').update(JSON.stringify(['native-thread', 'turn-1'])).digest('hex');
		expect(await readdir(f.grants.directory)).toContain(`${id}.revoked`);
		expect(attempts).toBeGreaterThanOrEqual(2);
		expect((await f.wire()).filter((r) => r.method === 'turn/interrupt')).toHaveLength(cancelFirst ? 1 : 0);
	});
	it('never rolls back an EEXIST original grant when only the conflicting temporary unlink fails', async () => {
		const f = await fixture({ PARK: '1', ATTACH: '1' }), grant = vi.spyOn(f.grants, 'grant');
		const original = f.driver.createRun(f.input); void collect(original.events);
		await vi.waitFor(() => expect(grant).toHaveBeenCalledOnce()); await grant.mock.results[0].value;
		publicationFault.unlink = async () => { throw Object.assign(new Error('pending unlink EACCES'), { code: 'EACCES' }); };
		const attached = f.driver.createRun({ ...f.input, runId: 'attached', replyToken: 'not-the-original' });
		expect(await collect(attached.events)).toEqual([{ type: 'error', message: 'NATIVE_OUTCOME_UNKNOWN: pending unlink EACCES' }]);
		await attached.dispose();
		const id = createHash('sha256').update(JSON.stringify(['native-thread', 'turn-1'])).digest('hex');
		expect(await readFile(join(f.grants.directory, `${id}.env`), 'utf8')).toContain("'secret-token'");
		expect(await readdir(f.grants.directory)).not.toContain(`${id}.revoked`);
		expect((await f.wire()).filter((r) => r.method === 'turn/interrupt')).toHaveLength(0);
	});
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
	it('binds the registered userMessage notification, never the turn/start submission ID', async () => {
		const f = await fixture({ DIFFERENT_ACK: '1' });
		const events = await collect(f.driver.createRun(f.input).events);
		expect(events.at(-1)?.type).toBe('done');
		expect(f.onNativeBound.mock.calls.map(([ref]) => ref)).toEqual([{ sessionId: 'native-thread', turnId: 'turn-1' }]);
		const submission = createHash('sha256').update(JSON.stringify(['native-thread', 'submission-only'])).digest('hex');
		await expect(readFile(join(f.grants.directory, `${submission}.env`), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
		expect((await f.wire()).filter((r) => r.method === 'turn/start')).toHaveLength(1);
		expect((await f.wire()).filter((r) => r.method === 'turn/interrupt')).toEqual([]);
	});
	it.each(['missing', 'foreign-client', 'foreign-thread', 'conflict'])('keeps %s input proof unknown, without a grant, resend or implicit interrupt', async (proof) => {
		const f = await fixture({ PROOF: proof });
		const run = f.driver.createRun(f.input);
		expect(await collect(run.events)).toEqual([{ type: 'error', message: expect.stringContaining('NATIVE_OUTCOME_UNKNOWN:') }]);
		await run.dispose();
		// The first genuine proof registers the ordinary owner synchronously; later conflict still issues zero grants.
		expect(f.onNativeBound).toHaveBeenCalledTimes(proof === 'conflict' ? 1 : 0);
		expect((await readdir(f.grants.directory)).filter((name) => name.endsWith('.env'))).toEqual([]);
		expect((await f.wire()).filter((r) => r.method === 'turn/start')).toHaveLength(1);
		expect((await f.wire()).filter((r) => r.method === 'turn/interrupt')).toEqual([]);
	});
	it('accepts duplicate started/completed evidence for the same native item exactly once', async () => {
		const f = await fixture({ PROOF: 'duplicate' });
		expect((await collect(f.driver.createRun(f.input).events)).at(-1)?.type).toBe('done');
		expect(f.onNativeBound).toHaveBeenCalledTimes(1);
	});
	it('never replaces or revokes an existing turn grant when safe core attachment is not connected', async () => {
		const f = await fixture({ ATTACH: '1', PARK: '1' });
		let ready!: () => void; const bound = new Promise<void>((resolve) => { ready = resolve; });
		f.input.onNativeBound = () => { ready(); };
		const original = collect(f.driver.createRun(f.input).events);
		await bound;
		const id = createHash('sha256').update(JSON.stringify(['native-thread', 'turn-1'])).digest('hex');
		await vi.waitFor(async () => expect(await readFile(join(f.grants.directory, `${id}.env`), 'utf8')).toContain('secret-token'));
		const attached = f.driver.createRun({ ...f.input, runId: 'request-2', replyToken: 'must-not-replace' });
		expect(await collect(attached.events)).toEqual([{ type: 'error', message: expect.stringContaining('NATIVE_OUTCOME_UNKNOWN:') }]);
		await attached.dispose();
		expect(await readFile(join(f.grants.directory, `${id}.env`), 'utf8')).toContain('secret-token');
		await expect(readFile(join(f.grants.directory, `${id}.revoked`), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
		expect((await f.wire()).filter((r) => r.method === 'turn/start')).toHaveLength(2);
		expect((await f.wire()).filter((r) => r.method === 'turn/interrupt')).toEqual([]);
		f.channels[0].close(); await original;
	});
	it('does not own an existing turn while its attached grant is deferred and cancellation wins', async () => {
		const f = await fixture({ ATTACH: '1', PARK: '1' });
		const original = collect(f.driver.createRun(f.input).events);
		const id = createHash('sha256').update(JSON.stringify(['native-thread', 'turn-1'])).digest('hex');
		await vi.waitFor(async () => expect(await readFile(join(f.grants.directory, `${id}.env`), 'utf8')).toContain('secret-token'));
		let entered!: () => void, release!: () => void;
		const waiting = new Promise<void>((resolve) => { entered = resolve; });
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const grant = f.grants.grant.bind(f.grants);
		vi.spyOn(f.grants, 'grant').mockImplementation(async (ref, token) => { entered(); await gate; await grant(ref, token); });
		const revoke = vi.spyOn(f.grants, 'revoke');
		const attached = f.driver.createRun({ ...f.input, runId: 'request-2', replyToken: 'must-not-replace' });
		const result = collect(attached.events);
		await waiting;
		expect(await attached.cancel('core-timeout')).toMatchObject({ status: 'unconfirmed' });
		release();
		expect(await result).toEqual([{ type: 'error', message: expect.stringContaining('NATIVE_OUTCOME_UNKNOWN:') }]);
		await attached.dispose();
		expect(revoke).not.toHaveBeenCalled();
		expect((await f.wire()).filter((r) => r.method === 'turn/interrupt')).toEqual([]);
		expect(await readFile(join(f.grants.directory, `${id}.env`), 'utf8')).toContain('secret-token');
		await expect(readFile(join(f.grants.directory, `${id}.revoked`), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
		f.channels[0].close(); await original;
	});
	it.each(['persist', 'lease'])('has no cleanup ownership when pregrant %s validation fails on an attached turn', async (fault) => {
		const f = await fixture({ ATTACH: '1', PARK: '1' });
		const original = collect(f.driver.createRun(f.input).events);
		const id = createHash('sha256').update(JSON.stringify(['native-thread', 'turn-1'])).digest('hex');
		await vi.waitFor(async () => expect(await readFile(join(f.grants.directory, `${id}.env`), 'utf8')).toContain('secret-token'));
		const revoke = vi.spyOn(f.grants, 'revoke');
		const attached = f.driver.createRun({ ...f.input, runId: 'request-2', replyToken: 'must-not-replace',
			saveRecovery: async (recovery) => { if (fault === 'persist' && (recovery.value as { nativeRef?: unknown }).nativeRef) throw new Error('disk full'); },
			assertReplySettlement: () => { if (fault === 'lease') throw new Error('lease expired'); } });
		expect(await collect(attached.events)).toEqual([{ type: 'error', message: expect.stringContaining('NATIVE_OUTCOME_UNKNOWN:') }]);
		await attached.dispose();
		expect(revoke).not.toHaveBeenCalled();
		expect((await f.wire()).filter((r) => r.method === 'turn/interrupt')).toEqual([]);
		expect(await readFile(join(f.grants.directory, `${id}.env`), 'utf8')).toContain('secret-token');
		await expect(readFile(join(f.grants.directory, `${id}.revoked`), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
		f.channels[0].close(); await original;
	});
	it('cleans its own grant if cancellation wins while a successful grant is pending', async () => {
		const f = await fixture({ PARK: '1' });
		let entered!: () => void, release!: () => void;
		const waiting = new Promise<void>((resolve) => { entered = resolve; });
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const grant = f.grants.grant.bind(f.grants);
		vi.spyOn(f.grants, 'grant').mockImplementation(async (ref, token) => { entered(); await gate; await grant(ref, token); });
		const run = f.driver.createRun(f.input), result = collect(run.events);
		await waiting;
		expect(await run.cancel('core-timeout')).toMatchObject({ status: 'unconfirmed' });
		expect((await f.wire()).filter((r) => r.method === 'turn/interrupt')).toEqual([]);
		release();
		expect(await result).toEqual([{ type: 'cancelled', reason: 'Codex native stop unconfirmed' }]);
		expect((await f.wire()).filter((r) => r.method === 'turn/interrupt').map((r) => r.params)).toEqual([{ threadId: 'native-thread', turnId: 'turn-1' }]);
		const id = createHash('sha256').update(JSON.stringify(['native-thread', 'turn-1'])).digest('hex');
		expect(await readFile(join(f.grants.directory, `${id}.revoked`), 'utf8')).toBe('');
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
		const grant = f.grants.grant.bind(f.grants);
		vi.spyOn(f.grants, 'grant').mockImplementation(async (ref, token) => {
			await grant(ref, token); setImmediate(() => { cancellation = run.cancel('user stop'); });
		});
		expect(await collect(run.events)).toEqual([{ type: 'cancelled', reason: 'Codex native stop unconfirmed' }]);
		expect(await cancellation).toMatchObject({ status: 'unconfirmed' });
		expect(await run.cancel('repeat')).toMatchObject({ status: 'unconfirmed' });
		await run.dispose();
		expect((await f.wire()).filter((r) => r.method === 'turn/interrupt').map((r) => r.params))
			.toEqual([{ threadId: 'native-thread', turnId: 'turn-1' }]);
		const id = createHash('sha256').update(JSON.stringify(['native-thread', 'turn-1'])).digest('hex');
		expect(await readFile(join(f.grants.directory, `${id}.revoked`), 'utf8')).toBe('');
		expect(await readFile(join(f.grants.directory, `${id}.env`), 'utf8')).toContain('secret-token');
	});
	it('revocation IO failure cannot short-circuit interrupt, wake or the unconfirmed stop result', async () => {
		const f = await fixture({ PARK: '1' });
		const run = f.driver.createRun(f.input);
		vi.spyOn(f.grants, 'revoke').mockRejectedValue(new Error('injected disk full'));
		let cancellation: ReturnType<typeof run.cancel> | undefined;
		const grant = f.grants.grant.bind(f.grants);
		vi.spyOn(f.grants, 'grant').mockImplementation(async (ref, token) => {
			await grant(ref, token); setImmediate(() => { cancellation = run.cancel('user stop'); });
		});
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
		const grant = f.grants.grant.bind(f.grants);
		vi.spyOn(f.grants, 'grant').mockImplementation(async (ref, token) => {
			await grant(ref, token); setImmediate(() => { abort.abort(); });
		});
		expect(await collect(f.driver.createRun(f.input).events)).toEqual([{ type: 'cancelled', reason: 'Codex native stop unconfirmed' }]);
		expect((await f.wire()).filter((r) => r.method === 'turn/interrupt')).toHaveLength(1);
	});
	it('late native identity from an old generation cannot receive a new usable grant', async () => {
		const f = await fixture();
		f.input.onNativeBound = () => { f.setCurrent(false); };
		expect(await collect(f.driver.createRun(f.input).events)).toEqual([{ type: 'error', message: 'NATIVE_OUTCOME_UNKNOWN: stale generation' }]);
		const id = createHash('sha256').update(JSON.stringify(['native-thread', 'turn-1'])).digest('hex');
		await expect(readFile(join(f.grants.directory, `${id}.revoked`), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
		await expect(readFile(join(f.grants.directory, `${id}.env`), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
	});
	it('event overflow is unknown, not a dropped native terminal or invented success', async () => {
		const f = await fixture({ FLOOD: '1' });
		expect(await collect(f.driver.createRun(f.input).events)).toEqual([{ type: 'error', message: 'NATIVE_OUTCOME_UNKNOWN: CODEX_RESULT_UNKNOWN: native event buffer exceeded' }]);
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
