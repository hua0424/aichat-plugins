// First-party Windows helper: build artifact is generated, never checked in.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') {
  if (process.arch !== 'x64') throw new Error('CC Windows helper build requires Windows x64');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const source = join(root, 'src/agent/cc/native/cc-job-supervisor.rs');
  const output = join(root, 'dist/native/cc-job-supervisor.exe');
  mkdirSync(dirname(output), { recursive: true });
  const args = ['--edition=2021', '--target', 'x86_64-pc-windows-msvc', '-O', '-C', 'metadata=cc-job-supervisor', '-C', 'link-arg=/Brepro', '-C', 'link-arg=/DEBUG:NONE', source, '-o', output];
  const env = { ...process.env };
  // VS Build Tools normally provide link.exe. Local x64 SDK-only environments may
  // opt into Rust's bundled lld with CC_JOB_LINKER and CC_JOB_SDK_LIB set explicitly.
  if (env.CC_JOB_LINKER) args.push('-C', `linker=${env.CC_JOB_LINKER}`);
  if (env.CC_JOB_SDK_LIB) env.LIB = [env.CC_JOB_SDK_LIB, env.LIB].filter(Boolean).join(';');
  const build = spawnSync('rustc', args, { env, stdio: 'inherit' });
  if (build.error) throw build.error;
  if (build.status !== 0) process.exit(build.status || 1);
  rmSync(join(dirname(output), 'cc-job-supervisor.pdb'), { force: true });
  const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const provenance = { source: 'src/agent/cc/native/cc-job-supervisor.rs',
    sourceSha256: hash(source), binarySha256: hash(output), target: 'x86_64-pc-windows-msvc',
    build: 'rustc --edition=2021 --target x86_64-pc-windows-msvc -O -C metadata=cc-job-supervisor -C link-arg=/Brepro -C link-arg=/DEBUG:NONE; record actual rustc/SDK externally for release' };
  writeFileSync(join(dirname(output), 'cc-job-supervisor.provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
  console.log(`CC Windows helper: ${output} sha256=${provenance.binarySha256}`);
}
