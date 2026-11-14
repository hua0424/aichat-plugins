// Node-only deterministic fixture check. No product imports, timers, CLI, or network.
// After an authorized fixture fix: node <this file> --require-atomic
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { mkdtemp, open, readFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

const source = (await readFile(new URL('./native-skill.test.ts', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const prefixStart = source.indexOf('await writeFile(script, `') + 'await writeFile(script, `'.length;
const prefixEnd = source.indexOf("require('node:readline')", prefixStart);
assert(prefixStart >= 'await writeFile(script, `'.length && prefixEnd > prefixStart, 'actual fixture prefix not found');
const rawPrefix = source.slice(prefixStart, prefixEnd);
assert(!rawPrefix.includes('${') && !rawPrefix.includes('`'), 'fixture prefix changed: review before evaluating');
const reader = runInNewContext('`' + rawPrefix + '`'); // Decode the actual fixture template, including its escapes.
const notify = /async notify\(index:[\s\S]*?\) \{\n([\s\S]*?)\n[ \t]*\},(?=\n[ \t]*async setEpoch)/.exec(source);
assert(notify, 'actual notify body not found');
const body = notify[1];
const direct = "await writeFile(join(home, 'notify-' + index), JSON.stringify({ method, params }));";
const atomic = "const file = join(home, 'notify-' + index), pending = file + '.' + randomUUID() + '.pending'; await writeFile(pending, JSON.stringify({ method, params })); await rename(pending, file);";
const currentAtomic = body.includes(atomic);
assert(body.includes(direct) !== currentAtomic, 'publication changed: review the two exact source forms');
const legacyBody = currentAtomic ? body.replace(atomic, direct) : body;
const atomicBody = currentAtomic ? body : body.replace(direct, atomic);
assert.match(source, /vi\.waitFor\(callback, \{ timeout: 3000 \}\)/);
const frame = { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } } };
const root = await mkdtemp(join(tmpdir(), 'codex-notify-window-'));
try {
  for (const [name, publisherBody] of [['legacy', legacyBody], ['atomic', atomicBody]]) {
    for (const window of ['empty', 'half']) {
      const home = await mkdtemp(join(root, 'case-')), final = join(home, 'notify-0'), frames = [], listeners = new Set();
      let poll;
      runInNewContext(reader, {
        require(id) { assert.equal(id, 'node:fs'); return fs; },
        process: { argv: [], env: { NOTIFY: final }, exit() { throw new Error('unexpected fixture exit'); }, stdout: { write(line) { const value = JSON.parse(line); frames.push(value); for (const listener of listeners) listener(value.method, value.params); } } },
        setInterval(callback, ms) { assert.equal(ms, 5); assert.equal(poll, undefined); poll = callback; },
      });
      assert.equal(typeof poll, 'function');
      const publisher = runInNewContext('(async function(index, method, params) {' + publisherBody + '\n})', {
        home, join, randomUUID,
        channels: [{ onNotification(listener) { listeners.add(listener); return () => listeners.delete(listener); } }],
        expect: value => ({ toBe: expected => assert.equal(value, expected) }), waitFor: callback => callback(),
        async writeFile(file, text) {
          const handle = await open(file, 'w'); // Real file creation/truncation, before the full JSON is written.
          try { const cut = window === 'half' ? Math.floor(text.length / 2) : 0; if (cut) await handle.writeFile(text.slice(0, cut)); poll(); await handle.writeFile(text.slice(cut)); } finally { await handle.close(); }
        },
        async rename(from, to) { assert.equal(dirname(from), dirname(to)); assert.equal(to, final); await rename(from, to); poll(); },
      });
      if (name === 'legacy') {
        await assert.rejects(publisher(0, frame.method, frame.params), error => error?.name === 'SyntaxError');
        assert.equal(frames.length, 0); assert.equal(listeners.size, 0);
        console.log(JSON.stringify({ publication: name, window, actualReader: 'SyntaxError', delivered: frames.length, visibleBytes: (await readFile(final)).length }));
      } else {
        await publisher(0, frame.method, frame.params); poll(); poll();
        assert.deepEqual(frames, [frame]); assert.equal(fs.existsSync(final), false); assert.equal(listeners.size, 0);
        console.log(JSON.stringify({ publication: name, window, actualReader: 'complete', delivered: frames.length }));
      }
    }
  }
  console.log(JSON.stringify({ currentFixture: currentAtomic ? 'atomic' : 'legacy', historicalFullFailureCause: 'UNKNOWN' }));
  if (process.argv.includes('--require-atomic')) assert(currentAtomic, 'current fixture publisher is not the checked atomic form');
} finally {
  assert.equal(dirname(root), resolve(tmpdir())); assert(basename(root).startsWith('codex-notify-window-'));
  await rm(root, { recursive: true, force: true }); // Only the exact temporary root created by this check.
}
