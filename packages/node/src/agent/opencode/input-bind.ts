import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, access, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface InputBinding {
 sessionID: string;
 inputID: string;
 conversationId: string;
 generation: number;
 systemPrompt: string;
 ready?: { token: string; runId: string; thinkingId: string };
}
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\x00-\x1f]/.test(v);
const digest = (v: string) => createHash('sha256').update(v).digest('hex');
const directory = (dir: string, session: string) => join(dir, 'inputs', digest(session));
const file = (dir: string, session: string, input: string) => join(directory(dir, session), `${digest(input)}.json`);
function valid(v: unknown): v is InputBinding {
 if (!v || typeof v !== 'object') return false;
 const b = v as InputBinding;
 return id(b.sessionID) && id(b.inputID) && id(b.conversationId) && Number.isSafeInteger(b.generation) && b.generation > 0 &&
  typeof b.systemPrompt === 'string' && Buffer.byteLength(b.systemPrompt) <= 65536 &&
  (b.ready === undefined || (!!b.ready && /^[a-f0-9]{64}$/.test(b.ready.token) && id(b.ready.runId) && id(b.ready.thinkingId)));
}
export async function managedSession(dir: string, session: string): Promise<boolean> {
 if (!id(session)) return false;
 try {
  // Windows can report ENOENT for a child of a regular file: verify ancestors before treating absence as legacy.
  for (const path of [join(dir, 'inputs'), directory(dir, session)])
   if (!(await stat(path)).isDirectory()) throw new Error('invalid native binding directory');
  await access(join(directory(dir, session), 'managed')); return true;
 }
 catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}
export async function readInput(dir: string, session: string, input: string): Promise<InputBinding | undefined> {
 if (!id(session) || !id(input)) return undefined;
 try {
  const b: unknown = JSON.parse(await readFile(file(dir, session, input), 'utf8'));
  if (!valid(b) || b.sessionID !== session || b.inputID !== input) return undefined;
  try {
   const ready: unknown = JSON.parse(await readFile(`${file(dir, session, input)}.ready`, 'utf8'));
   if (valid({ ...b, ready })) b.ready = ready as InputBinding['ready'];
  } catch { /* Exclusive ready publication can be observed while bytes are being written; retry until budget. */ }
  return b;
 } catch { return undefined; }
}
export async function publishInput(dir: string, b: InputBinding): Promise<void> {
 if (!valid(b) || b.ready) throw new Error('invalid native input binding');
 await mkdir(directory(dir, b.sessionID), { recursive: true });
 await writeFile(join(directory(dir, b.sessionID), 'managed'), '', { mode: 0o600 });
 try { await writeFile(file(dir, b.sessionID, b.inputID), JSON.stringify(b), { mode: 0o600, flag: 'wx' }); }
 catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  const previous = await readInput(dir, b.sessionID, b.inputID);
  if (!previous || JSON.stringify({ ...previous, ready: undefined }) !== JSON.stringify(b)) throw new Error('native input binding conflict');
 }
}
export async function readyInput(dir: string, session: string, input: string, ready: NonNullable<InputBinding['ready']>): Promise<void> {
 const b = await readInput(dir, session, input);
 if (!b || !valid({ ...b, ready })) throw new Error('invalid native ready binding');
 if (b.ready) {
  if (JSON.stringify(b.ready) !== JSON.stringify(ready)) throw new Error('native ready binding conflict');
  return;
 }
 try { await writeFile(`${file(dir, session, input)}.ready`, JSON.stringify(ready), { mode: 0o600, flag: 'wx' }); }
 catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  const existing = await readInput(dir, session, input);
  if (JSON.stringify(existing?.ready) !== JSON.stringify(ready)) throw new Error('native ready binding conflict');
 }
}
export async function removeInput(dir: string, session: string, input: string): Promise<void> {
 if (!id(session) || !id(input)) return;
 for (const target of [file(dir, session, input), `${file(dir, session, input)}.ready`])
  await unlink(target).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
}

/** Native facts only. An ID with conflicting ancestry remains poisoned, never last-write-wins. */
export class NativeParents {
 private readonly assistants = new Map<string, string | null>();
 private readonly calls = new Map<string, string | null>();
 private key(session: string, value: string): string { return JSON.stringify([session, value]); }
 private add(map: Map<string, string | null>, key: string, value: string): void {
  if (!map.has(key)) map.set(key, value);
  else if (map.get(key) !== value) map.set(key, null);
 }
 observe(raw: unknown): void {
  const e = raw as { type?: string; properties?: { info?: { role?: string; sessionID?: string; id?: string; parentID?: string }; part?: { type?: string; sessionID?: string; callID?: string; messageID?: string } } };
  const m = e?.properties?.info, p = e?.properties?.part;
  if (e?.type === 'message.updated' && m?.role === 'assistant' && id(m.sessionID) && id(m.id) && id(m.parentID))
   this.add(this.assistants, this.key(m.sessionID, m.id), m.parentID);
  if (e?.type === 'message.part.updated' && p?.type === 'tool' && id(p.sessionID) && id(p.callID) && id(p.messageID))
   this.add(this.calls, this.key(p.sessionID, p.callID), p.messageID);
 }
 parent(session: string, call: string): { messageID: string; inputID: string } | undefined {
  const messageID = this.calls.get(this.key(session, call));
  if (messageID === null) throw new Error('ambiguous native tool ancestry');
  if (messageID === undefined) return undefined;
  const inputID = this.assistants.get(this.key(session, messageID));
  if (inputID === null) throw new Error('ambiguous native assistant ancestry');
  return inputID === undefined ? undefined : { messageID, inputID };
 }
}
