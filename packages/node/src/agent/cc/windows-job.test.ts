import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WindowsJobChild } from './windows-job.js';

const binary = join(import.meta.dirname ?? '', '../../../dist/native/cc-job-supervisor.exe');
const folders: string[] = [];
afterEach(() => { for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const bounded = <T>(promise: Promise<T>) => Promise.race([promise, delay(3000).then(() => { throw new Error('supervisor close timed out'); })]);
const options = (cwd: string) => ({ cwd, env: process.env, detached: false as const,
	stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] });
function script(text: string) {
	const dir = mkdtempSync(join(tmpdir(), 'cc-job-real-')); folders.push(dir);
	const file = join(dir, 'child.cjs'); writeFileSync(file, text);
	return { dir, file };
}
function waitClose(child: WindowsJobChild): Promise<number | null> {
	return new Promise((resolve) => child.once('close', (code: number | null) => resolve(code)));
}
async function cleanup(child: WindowsJobChild, finished: Promise<number | null>): Promise<void> {
	if (child.verifiedGone) return;
	child.kill();
	try { await bounded(finished); } catch {
		// Only kill the helper this fixture owns. Closing its Job handle kills its children.
		(child as unknown as { helper: ChildProcessWithoutNullStreams }).helper.kill();
		await bounded(finished);
	}
}
function monitor(helper: ChildProcessWithoutNullStreams) {
	const frames: Array<{ kind: number; bytes: Buffer }> = []; let buffer = Buffer.alloc(0);
	helper.stdout.on('data', (chunk: Buffer) => {
		buffer = Buffer.concat([buffer, chunk]);
		while (buffer.length >= 5 && buffer.length >= buffer.readUInt32LE(1) + 5) {
			const length = buffer.readUInt32LE(1);
			frames.push({ kind: buffer[0], bytes: buffer.subarray(5, 5 + length) });
			buffer = buffer.subarray(5 + length);
		}
	});
	return frames;
}
const windows = process.platform === 'win32' && existsSync(binary) ? describe : describe.skip;
windows('real Windows Job Object supervisor', () => {
	it('waits for a detached descendant after root exit, then confirms empty job', async () => {
		const { dir, file } = script(`const {spawn}=require('node:child_process');
const descendant=spawn(process.execPath,['-e','process.stdout.write("child-start\\\\n");setTimeout(()=>process.stdout.write("descendant\\\\n"),350)'],{stdio:'inherit',detached:true});
process.stdout.write('root:'+descendant.pid+'\\n'); process.stderr.write('err\\n'); descendant.unref(); setTimeout(()=>process.exit(0),100);`);
		const child = new WindowsJobChild(process.execPath, [file], options(dir), binary);
		const lines: string[] = []; const errors: string[] = [];
		child.stdout.on('data', (chunk: Buffer) => lines.push(chunk.toString()));
		child.stderr.on('data', (chunk: Buffer) => errors.push(chunk.toString()));
		let closed = false; const finished = waitClose(child).then((code) => { closed = true; return code; });
		try {
			await child.ready; child.stdin.write(''); child.stdin.end();
			await delay(200); // root exited; detached descendant still runs
			expect(closed).toBe(false);
			expect(await bounded(finished)).toBe(0);
			expect(child.verifiedGone).toBe(true);
			expect(lines.join('')).toContain('descendant\n');
			expect(errors.join('')).toContain('err\n');
			const descendantPid = Number(lines.join('').match(/root:(\d+)/)?.[1]);
			expect(descendantPid).toBeGreaterThan(0);
			expect(() => process.kill(descendantPid, 0)).toThrow();
		} finally { await cleanup(child, finished); }
	}, 10_000);

	it('terminates root and descendant on cancel and proves job empty', async () => {
		const { dir, file } = script(`const {spawn}=require('node:child_process');
const descendant=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'inherit',detached:true});
process.stdout.write('pid:'+descendant.pid+'\\n'); descendant.unref(); setTimeout(()=>{},30000);`);
		const child = new WindowsJobChild(process.execPath, [file], options(dir), binary);
		let output = ''; child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
		const finished = waitClose(child);
		try {
			await child.ready; child.stdin.write(''); child.stdin.end();
			for (let i = 0; !output.includes('\n') && i < 100; i++) await delay(20);
			const grandchild = Number(output.match(/pid:(\d+)/)?.[1]);
			expect(grandchild).toBeGreaterThan(0);
			child.kill();
			expect(await bounded(finished)).not.toBe(0);
			expect(child.verifiedGone).toBe(true);
			expect(() => process.kill(grandchild, 0)).toThrow();
		} finally { await cleanup(child, finished); }
	}, 10_000);

	it('proves an early-exit child stopped even when its stdin delivery fails', async () => {
		const { dir, file } = script('process.exit(0)');
		const child = new WindowsJobChild(process.execPath, [file], options(dir), binary);
		const finished = waitClose(child);
		try {
			await child.ready;
			child.stdin.write('x'.repeat(1024 * 1024)); child.stdin.end();
			expect(await bounded(finished)).not.toBe(0); // partial input must never look successful
			expect(child.verifiedGone).toBe(true); // root and job are nevertheless proven stopped
			expect(() => process.kill(child.pid!, 0)).toThrow();
		} finally { await cleanup(child, finished); }
	}, 10_000);

	it('cancels promptly even when child never reads a pipe-capacity-exceeding stdin', async () => {
		const { dir, file } = script('setTimeout(()=>{},30000)');
		const child = new WindowsJobChild(process.execPath, [file], options(dir), binary);
		const finished = waitClose(child);
		try {
			await child.ready;
			child.stdin.write('x'.repeat(1024 * 1024)); child.stdin.end();
			await delay(100);
			child.kill();
			expect(await bounded(finished)).not.toBe(0);
			expect(child.verifiedGone).toBe(true);
			expect(() => process.kill(child.pid!, 0)).toThrow();
		} finally { await cleanup(child, finished); }
	}, 10_000);

	for (const [label, bytes] of [['corrupt frame', Buffer.from([88, 0, 0, 0, 0])], ['control EOF', null]] as const) {
		it(`kills its job without trusted D on ${label}`, async () => {
			const { dir, file } = script('setTimeout(()=>{},30000)');
			const helper = spawn(binary, [process.execPath, file], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
			const frames = monitor(helper);
			let exited = false;
			const closed = new Promise<number | null>((resolve) => helper.once('close', (code) => { exited = true; resolve(code); }));
			try {
				if (bytes) helper.stdin.write(bytes);
				else {
					const header = Buffer.alloc(5); header[0] = 73; header.writeUInt32LE(1024 * 1024, 1);
					helper.stdin.write(Buffer.concat([header, Buffer.alloc(1024 * 1024, 120), Buffer.from([69, 0, 0, 0, 0])]));
					helper.stdin.end(); // EOF while native WriteFile blocks behind non-reading child
				}
				expect(await bounded(closed)).not.toBe(0);
				const pid = frames.find((item) => item.kind === 80)?.bytes.readUInt32LE();
				expect(pid).toBeGreaterThan(0);
				expect(() => process.kill(pid!, 0)).toThrow();
				expect(frames.some((item) => item.kind === 68)).toBe(false);
			} finally {
				if (!exited) { helper.kill(); await bounded(closed); }
			}
		}, 10_000);
	}
});
