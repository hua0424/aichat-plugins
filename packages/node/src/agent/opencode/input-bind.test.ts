import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishInput, readyInput, readInput, NativeParents, managedSession } from './input-bind.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });
describe('native input binding', () => {
 it('fails closed on managed-marker IO failure and never overwrites a concurrent ready binding', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-input-')); dirs.push(dir);
  await writeFile(join(dir, 'inputs'), 'not a directory');
  await expect(managedSession(dir, 's')).rejects.toThrow();
  const other = await mkdtemp(join(tmpdir(), 'oc-input-')); dirs.push(other);
  await publishInput(other, { sessionID: 's', inputID: 'u', conversationId: 'c', generation: 1, systemPrompt: 'p' });
  const results = await Promise.allSettled([
   readyInput(other, 's', 'u', { token: 'a'.repeat(64), runId: 'a', thinkingId: 'ta' }),
   readyInput(other, 's', 'u', { token: 'b'.repeat(64), runId: 'b', thinkingId: 'tb' }),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  const before = await readInput(other, 's', 'u');
  await expect(readyInput(other, 's', 'u', { token: 'c'.repeat(64), runId: 'c', thinkingId: 'tc' })).rejects.toThrow('conflict');
  expect(await readInput(other, 's', 'u')).toEqual(before);
 });
 it('freezes persona per input and publishes readiness without replacing another input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-input-')); dirs.push(dir);
  await publishInput(dir, { sessionID: 'ses_a', inputID: 'msg_a', generation: 1, conversationId: 'c', systemPrompt: 'persona A' });
  await publishInput(dir, { sessionID: 'ses_a', inputID: 'msg_b', generation: 1, conversationId: 'c', systemPrompt: 'persona B' });
  await readyInput(dir, 'ses_a', 'msg_a', { token: 'a'.repeat(64), runId: 'run-a', thinkingId: 'think-a' });
  expect(await readInput(dir, 'ses_a', 'msg_a')).toMatchObject({ systemPrompt: 'persona A', ready: { runId: 'run-a' } });
  expect(await readInput(dir, 'ses_a', 'msg_b')).toMatchObject({ systemPrompt: 'persona B' });
  expect((await readInput(dir, 'ses_a', 'msg_b'))?.ready).toBeUndefined();
  await expect(publishInput(dir, { sessionID: 'ses_a', inputID: 'msg_a', generation: 1, conversationId: 'c', systemPrompt: 'foreign' })).rejects.toThrow('conflict');
 });
 it('maps exact native call parent, tolerates replay, and rejects conflicting ancestors', () => {
  const ledger = new NativeParents();
  const message = { type: 'message.updated', properties: { info: { sessionID: 's', id: 'assistant', role: 'assistant', parentID: 'user' } } };
  const part = { type: 'message.part.updated', properties: { part: { sessionID: 's', type: 'tool', callID: 'call', messageID: 'assistant' } } };
  ledger.observe(part); ledger.observe(message); ledger.observe(message);
  expect(ledger.parent('s', 'call')).toEqual({ messageID: 'assistant', inputID: 'user' });
  expect(ledger.parent('other', 'call')).toBeUndefined();
  ledger.observe({ ...message, properties: { info: { ...message.properties.info, parentID: 'foreign' } } });
  expect(() => ledger.parent('s', 'call')).toThrow('ambiguous');
 });
});
