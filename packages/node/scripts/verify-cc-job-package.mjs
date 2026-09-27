// Pack gate: POSIX-only packages remain possible; Windows-capable packages require the reviewed artifact.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const native = join(root, 'dist/native');
const source = join(root, 'src/agent/cc/native/cc-job-supervisor.rs');
const binary = join(native, 'cc-job-supervisor.exe');
const record = join(native, 'cc-job-supervisor.provenance.json');
if (existsSync(native)) {
  const unexpected = readdirSync(native).filter((name) =>
    name !== 'cc-job-supervisor.exe' && name !== 'cc-job-supervisor.provenance.json');
  if (unexpected.length) throw new Error(`Unexpected CC native package files; inspect before release: ${unexpected.join(', ')}`);
}
if (!existsSync(binary) && !existsSync(record) && process.platform !== 'win32') {
  console.warn('POSIX-only package: no CC Windows helper; this artifact must not be distributed as Windows-capable');
} else {
  if (process.platform === 'win32' && process.arch !== 'x64' || !existsSync(binary) || !existsSync(record)) {
    throw new Error('CC Windows helper missing/unsupported: build on Windows x64 or supply independently reviewed artifact');
  }
  const bytes = readFileSync(binary);
  const pe = bytes.length >= 0x40 ? bytes.readUInt32LE(0x3c) : bytes.length;
  if (bytes.subarray(0, 2).toString() !== 'MZ' || pe + 6 > bytes.length ||
      bytes.subarray(pe, pe + 4).toString() !== 'PE\0\0' || bytes.readUInt16LE(pe + 4) !== 0x8664) {
    throw new Error('CC Windows helper is not a Windows x64 PE executable');
  }
  const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const provenance = JSON.parse(readFileSync(record, 'utf8'));
  if (provenance.target !== 'x86_64-pc-windows-msvc' || provenance.sourceSha256 !== hash(source) ||
      provenance.binarySha256 !== hash(binary)) {
    throw new Error('CC Windows helper source/binary provenance mismatch; rebuild and independently review');
  }
  console.log(`CC Windows package verified: ${provenance.binarySha256}`);
}
