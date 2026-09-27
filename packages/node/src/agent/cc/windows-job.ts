import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import type { CcChild, CcSpawnOptions } from './headless-driver.js';

// The binary is built from native/cc-job-supervisor.rs into ignored dist/native.
// Missing build artifact is an error, never a fallback to uncontained child_process.spawn.
const moduleDir = dirname(fileURLToPath(import.meta.url));
const helperPath = [join(moduleDir, '../../native/cc-job-supervisor.exe'),
	join(moduleDir, '../../../dist/native/cc-job-supervisor.exe')].find(existsSync) ??
	join(moduleDir, '../../native/cc-job-supervisor.exe');
const MAX_FRAME = 8 * 1024 * 1024;
const frame = (kind: string, payload = Buffer.alloc(0)) => {
	const header = Buffer.alloc(5);
	header.writeUInt8(kind.charCodeAt(0));
	header.writeUInt32LE(payload.length, 1);
	return Buffer.concat([header, payload]);
};

/** A CcChild backed by an independent Windows Job Object; only the helper's D frame confirms stop. */
export class WindowsJobChild extends EventEmitter implements CcChild {
	pid?: number;
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly stdin: { write(chunk: string): void; end(): void };
	readonly ready: Promise<void>;
	verifiedGone = false;
	private readonly helper: ChildProcessWithoutNullStreams;
	private pending = Buffer.alloc(0);
	private doneCode?: number;
	private resolveReady!: () => void;
	private rejectReady!: (error: Error) => void;
	private readySettled = false;
	private protocolError?: Error;
	private helperStderr = '';
	private exited = false;

	constructor(command: string, args: readonly string[], options: CcSpawnOptions, binary = helperPath) {
		super();
		if (!existsSync(binary)) throw new Error(`CC Windows Job Object helper missing: ${binary}; build/package the native helper first`);
		this.ready = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
		this.helper = spawn(binary, [command, ...args], { cwd: options.cwd, env: options.env, windowsHide: true,
			stdio: ['pipe', 'pipe', 'pipe'] });
		this.stdin = {
			write: (text) => { this.helper.stdin.write(frame('I', Buffer.from(text))); },
			end: () => { this.helper.stdin.write(frame('E')); },
		};
		this.helper.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
		this.helper.stderr.on('data', (chunk: Buffer) => { this.helperStderr = (this.helperStderr + chunk.toString()).slice(-500); });
		this.helper.on('error', (error) => { this.fail(error); this.emit('error', error); });
		this.helper.on('close', (code) => {
			this.exited = true;
			this.verifiedGone = !this.protocolError && this.pending.length === 0 && code === 0 &&
				this.doneCode !== undefined && this.pid !== undefined;
			if (!this.readySettled) this.fail(this.protocolError ?? new Error(`CC Windows supervisor exited before child assignment: ${this.helperStderr}`));
			this.stdout.end(); this.stderr.end();
			this.emit('close', this.verifiedGone ? this.doneCode! : null, null);
		});
	}
	private fail(error: Error): void {
		this.protocolError = error;
		if (!this.readySettled) { this.readySettled = true; this.rejectReady(error); }
	}
	private receive(bytes: Buffer): void {
		if (this.protocolError) return;
		this.pending = Buffer.concat([this.pending, bytes]);
		while (this.pending.length >= 5) {
			const length = this.pending.readUInt32LE(1);
			if (length > MAX_FRAME) { this.fail(new Error('CC Windows supervisor oversized frame')); this.kill(); return; }
			if (this.pending.length < 5 + length) return;
			const kind = this.pending[0];
			const payload = this.pending.subarray(5, 5 + length);
			this.pending = this.pending.subarray(5 + length);
			if (kind === 80 && length === 4 && this.pid === undefined && this.doneCode === undefined) {
				this.pid = payload.readUInt32LE();
				if (!this.pid) { this.fail(new Error('CC Windows supervisor invalid child PID')); return; }
				this.readySettled = true; this.resolveReady();
			} else if (kind === 79 && this.pid !== undefined && this.doneCode === undefined) this.stdout.write(payload);
			else if (kind === 82 && this.pid !== undefined && this.doneCode === undefined) this.stderr.write(payload);
			else if (kind === 68 && length === 4 && this.pid !== undefined && this.doneCode === undefined) this.doneCode = payload.readInt32LE();
			else { this.fail(new Error('CC Windows supervisor invalid frame sequence')); this.kill(); return; }
		}
	}
	kill(): boolean {
		if (this.exited) return false;
		return this.helper.stdin.write(frame('K'));
	}
	/** Last-resort containment on timeout: killing our helper closes its Job handle; never stop proof. */
	forceKillHelper(): void { if (!this.exited) this.helper.kill(); }
}

export function assertWindowsJobAvailable(): void {
	if (process.arch !== 'x64') throw new Error(`CC Windows Job Object helper supports x64 only, got ${process.arch}`);
	if (!existsSync(helperPath)) throw new Error(`CC Windows Job Object helper missing: ${helperPath}; include dist/native in the Windows release`);
}

export function spawnWindowsJob(command: string, args: readonly string[], options: CcSpawnOptions): WindowsJobChild {
	return new WindowsJobChild(command, args, options);
}
