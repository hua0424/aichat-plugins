import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAppServer } from './app-server.js';

// A fresh child implements the pinned JSONL shapes; it never launches Codex or a provider.
const program = `
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log(process.env.FAKE_VERSION || 'codex-cli 0.142.3'); process.exit(0); }
const readline = require('node:readline');
const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
 const request = JSON.parse(line);
 fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(request) + '\\n');
 if (!request.method) return;
 if (request.method === 'initialized') return;
 if (request.method === 'initialize') { send({id:request.id,result:{userAgent:'aichat/0.142.3 (test; 1)'}}); return; }
 if (request.method === 'no-response') return;
 if (request.method === 'malformed') { process.stdout.write('{not-json}\\n'); return; }
 if (request.method === 'fail') { send({id:request.id,error:{code:-32602,message:'secret-must-not-escape'}}); return; }
 if (request.method === 'approval') {
  send({id:27,method:'item/commandExecution/requestApproval',params:{threadId:'t',turnId:'u',itemId:'i'}});
  send({id:request.id,result:{}}); return;
 }
 if (request.method === 'thread/read') {
  send({id:'unrelated',result:{thread:{id:'wrong'}}});
  send({method:'turn/started',params:{threadId:'t',turn:{id:'u',status:'inProgress',items:[]}}});
  const text = JSON.stringify({id:request.id,result:{thread:{id:'t',preview:'中文'}}})+'\\n';
  const data = Buffer.from(text); const cut = data.indexOf(Buffer.from('中文'))+1;
  process.stdout.write(data.subarray(0,cut)); setTimeout(()=>process.stdout.write(data.subarray(cut)),5); return;
 }
 send({id:request.id,result:{pid:process.pid}});
});
`;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
async function create(extra: NodeJS.ProcessEnv = {}, timeoutMs = 2000) {
	const directory = await mkdtemp(join(tmpdir(), 'aichat-codex-jsonl-507-'));
	const script = join(directory, 'fake.cjs');
	const log = join(directory, 'wire.jsonl');
	await writeFile(script, program);
	const channel = new CodexAppServer({ command: process.execPath, prefix: [script], timeoutMs,
		env: { ...process.env, FAKE_LOG: log, ...extra } });
	cleanup.push(async () => { channel.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }); });
	return { channel, wire: async () => (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)) };
}

describe('Codex 0.142.3 continuous app-server channel', () => {
	it('negotiates experimental API once and keeps the same native child across requests', async () => {
		const { channel, wire } = await create();
		await Promise.all([channel.start(), channel.start()]);
		const first = await channel.request('pid', {});
		expect(await channel.request('pid', {})).toEqual(first);
		const frames = await wire();
		expect(frames[0]).toMatchObject({ method: 'initialize', params: { capabilities: { experimentalApi: true } } });
		expect(frames.filter((frame) => frame.method === 'initialize')).toHaveLength(1);
		expect(frames[1]).toEqual({ method: 'initialized', params: {} });
	});
	it('refuses a wrong CLI before starting app-server', async () => {
		const { channel, wire } = await create({ FAKE_VERSION: 'codex-cli 0.142.4' });
		await expect(channel.start()).rejects.toThrow('CODEX_VERSION_UNVERIFIED');
		await expect(wire()).rejects.toMatchObject({ code: 'ENOENT' });
	});
	it('correlates IDs and decodes split UTF8 without treating notifications as responses', async () => {
		const { channel } = await create();
		const notifications: unknown[] = [];
		channel.onNotification((method, params) => notifications.push({ method, params }));
		await channel.start();
		expect(await channel.request('thread/read', { threadId: 't', includeTurns: true })).toEqual({ thread: { id: 't', preview: '中文' } });
		expect(notifications).toEqual([{ method: 'turn/started', params: { threadId: 't', turn: { id: 'u', status: 'inProgress', items: [] } } }]);
	});
	it('does not expose native error messages', async () => {
		const { channel } = await create();
		await channel.start();
		await expect(channel.request('fail', {})).rejects.toThrow(/^CODEX_NATIVE_REQUEST_FAILED$/);
	});
	it('reports missing RPC result as unknown and never resends the request', async () => {
		const { channel, wire } = await create({}, 2000);
		await channel.start();
		await expect(channel.request('no-response', { threadId: 't' })).rejects.toThrow('CODEX_RESULT_UNKNOWN');
		expect((await wire()).filter((frame) => frame.method === 'no-response')).toHaveLength(1);
		expect(await channel.request('pid', {})).toHaveProperty('pid');
	});
	it('fails closed on malformed protocol and rejects pending requests', async () => {
		const { channel } = await create();
		await channel.start();
		await expect(channel.request('malformed', {})).rejects.toThrow('CODEX_PROTOCOL_INVALID');
		await expect(channel.request('pid', {})).rejects.toThrow('CODEX_CHANNEL_CLOSED');
	});
	it('never approves native server permission requests', async () => {
		const { channel, wire } = await create();
		await channel.start();
		await channel.request('approval', {});
		await channel.request('pid', {}); // flush client response through fake's stdin
		expect((await wire()).find((frame) => frame.id === 27)).toEqual({ id: 27, error: { code: -32601, message: 'Unsupported client request' } });
	});
	it('rejects outstanding requests on close without claiming native process-tree stop', async () => {
		const { channel } = await create();
		await channel.start();
		const pending = channel.request('no-response', {});
		channel.close();
		await expect(pending).rejects.toThrow('CODEX_CHANNEL_CLOSED');
	});
});
