import { ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { DriverDisconnectIncompleteError } from '../events.js';
import type { CcChild, CcKillFn, CcSpawnFn } from './headless-driver.js';
import { assertWindowsJobAvailable, spawnWindowsJob, WindowsJobChild } from './windows-job.js';

const MAX_OUTPUT_BYTES = 512 * 1024; // Per stream; stderr is drained, never kept.
const KILL_GRACE_MS = 3_000;
const CLEANUP_MS = 7_000;

interface ControlIO<T> {
	write(frame: object, beforeWrite?: () => void): void;
	complete(value: T): void;
	fail(reason: string): void;
}

/** Resolve only after the protocol completes and the owned process is confirmed gone. */
export async function runCcControlChild<T>({ label, cwd, signal, argv, env, deadlineMs, claudeBin = 'claude',
	spawn, kill = process.kill, platform = process.platform, initialize, onLine }: {
	label: string; cwd: string; signal: AbortSignal; argv: string[]; env: NodeJS.ProcessEnv; deadlineMs: number;
	claudeBin?: string; spawn?: CcSpawnFn; kill?: CcKillFn; platform?: NodeJS.Platform;
	initialize(io: ControlIO<T>): void; onLine(line: string, io: ControlIO<T>): void;
}): Promise<T> {
	if (signal.aborted) throw new Error(`CC ${label} aborted`);
	const windows = platform === 'win32';
	let child: CcChild;
	try {
		if (windows && !spawn) assertWindowsJobAvailable();
		child = (spawn ?? (windows ? spawnWindowsJob : nodeSpawn))(claudeBin, argv,
			{ cwd, env, detached: !windows, stdio: ['pipe', 'pipe', 'pipe'] });
	} catch { throw new Error(`CC ${label} launch failed`); }

	return new Promise((resolve, reject) => {
		const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
		let pending = '', stdoutBytes = 0, stderrBytes = 0, started = false;
		let result: { value: T } | undefined, failure: string | undefined, settled = false;
		let close: { code: number | null; signal: string | null } | undefined;
		let retry: ReturnType<typeof setInterval> | undefined;
		const deadline = setTimeout(() => fail('deadline exceeded'), deadlineMs);
		const onAbort = () => fail('aborted');
		const ownedPid = () => child.pid && child.pid > 0 && Number.isSafeInteger(child.pid) ? child.pid : undefined;
		const io: ControlIO<T> = {
			write(frame, beforeWrite) {
				if (signal.aborted) return onAbort();
				if (!started || settled || failure || result || close) return;
				if (!child.stdin || child.stdin.writable === false) return fail('input closed');
				try { beforeWrite?.(); }
				catch { return fail('original scope changed'); }
				try { child.stdin!.write(`${JSON.stringify(frame)}\n`); }
				catch { fail('input failed'); }
			},
			complete(value) {
				if (!started || settled || failure || result) return;
				result = { value };
				try { child.stdin!.end(); }
				catch { fail('input failed'); }
			},
			fail,
		};

		function groupGone(): boolean {
			if (windows) return child instanceof WindowsJobChild && (child.verifiedGone || child.helperNeverLaunched);
			const pid = ownedPid();
			if (!pid) return child instanceof ChildProcess && child.pid === undefined;
			try { kill(-pid, 0); return false; }
			catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
		}
		function signalGroup(sig: NodeJS.Signals) {
			try {
				const pid = ownedPid();
				if (windows) child.kill(sig);
				else if (pid) kill(-pid, sig);
			} catch { /* Only close and independent process-group proof determine teardown. */ }
		}
		function finish(error?: Error) {
			settled = true;
			clearTimeout(deadline);
			clearInterval(retry);
			signal.removeEventListener('abort', onAbort);
			if (error) reject(error);
			else resolve(result!.value);
		}
		function confirmClose(): boolean {
			if (!close || !groupGone()) return false;
			const reason = failure ?? (!result || close.code !== 0 || close.signal !== null ? 'did not complete' : undefined);
			finish(reason ? new Error(`CC ${label} ${reason}`) : undefined);
			return true;
		}
		function fail(reason: string) {
			if (failure || settled) return;
			failure = reason;
			clearTimeout(deadline);
			pending = '';
			result = undefined;
			if (confirmClose()) return;
			const stoppingAt = performance.now();
			let escalated = false;
			retry = setInterval(() => {
				if (confirmClose()) return;
				const elapsed = performance.now() - stoppingAt;
				if (!escalated && elapsed >= KILL_GRACE_MS) {
					escalated = true;
					signalGroup('SIGKILL');
				}
				if (!settled && elapsed >= CLEANUP_MS) {
					if (child instanceof WindowsJobChild) child.forceKillHelper(); // Job kill-on-close; not proof.
					finish(new DriverDisconnectIncompleteError(`CC ${label} cleanup unconfirmed`));
				}
			}, 20);
			signalGroup('SIGTERM');
		}
		function start() {
			if (settled || failure || started) return;
			if (signal.aborted) return onAbort();
			if (!child.stdin || !child.stdout || !child.stderr) return fail('launch failed');
			started = true;
			try { initialize(io); }
			catch { fail('input failed'); }
		}

		signal.addEventListener('abort', onAbort, { once: true });
		child.on('error', () => fail('process failed'));
		child.on('close', (code, exitSignal) => {
			if (settled || close) return;
			close = { code, signal: exitSignal };
			if (!failure) {
				try { if ((pending + decoder.decode()).trim()) fail('received an incomplete frame'); }
				catch { fail('received malformed output'); }
			}
			if (!settled && !confirmClose()) fail('process group did not exit with its child');
		});
		child.stdout?.on('data', (chunk) => {
			if (settled || failure) return;
			stdoutBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
			if (stdoutBytes > MAX_OUTPUT_BYTES) return fail('stdout limit exceeded');
			try {
				pending += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
				let newline: number;
				while (!settled && !failure && (newline = pending.indexOf('\n')) >= 0) {
					const line = pending.slice(0, newline);
					pending = pending.slice(newline + 1);
					if (!line.trim()) continue;
					if (!started || result) return fail('received an unexpected frame');
					onLine(line, io);
				}
			} catch { fail('received malformed output'); }
		});
		child.stderr?.on('data', (chunk) => {
			if (settled || failure) return;
			stderrBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
			if (stderrBytes > MAX_OUTPUT_BYTES) fail('stderr limit exceeded');
		});
		if (child instanceof ChildProcess) {
			child.stdin?.on('error', () => fail('input failed'));
			child.stdout?.on('error', () => fail('output failed'));
			child.stderr?.on('error', () => fail('output failed'));
			child.once('spawn', start);
		} else if (child instanceof WindowsJobChild) {
			void child.ready.then(start, () => fail('launch failed'));
		} else start();
		if (signal.aborted) onAbort();
	});
}
