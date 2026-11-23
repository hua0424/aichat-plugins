import { ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DriverDisconnectIncompleteError } from '../events.js';
import type { CcChild, CcKillFn, CcSpawnFn } from './headless-driver.js';
import { assertWindowsJobAvailable, spawnWindowsJob, WindowsJobChild } from './windows-job.js';

const MAX_OUTPUT_BYTES = 512 * 1024; // Per stream; stderr is drained, never kept.
const DEADLINE_MS = 22_000;
const KILL_GRACE_MS = 3_000;
const CLEANUP_MS = 7_000;
const inventoryString = (value: unknown): value is string => typeof value === 'string' &&
	value.length <= 256 && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value);

type NativeModel = { value: string; displayName: string };

/** One disposable native inventory request, not a chat run. Safe mode still permits admin managed policy. */
export async function readCcModelInventory({ cwd, signal, claudeBin = 'claude', spawn, kill = process.kill,
	platform = process.platform }: { cwd: string; signal: AbortSignal; claudeBin?: string; spawn?: CcSpawnFn;
	kill?: CcKillFn; platform?: NodeJS.Platform }): Promise<NativeModel[]> {
	if (signal.aborted) throw new Error('CC model inventory aborted');
	const windows = platform === 'win32';
	const requestId = randomUUID();
	const argv = ['-p', '--safe-mode', '--no-session-persistence', '--input-format', 'stream-json',
		'--output-format', 'stream-json', '--verbose', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
	const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_NON_INTERACTIVE: '1', MAX_RETRIES: '0' };
	for (const key of Object.keys(env)) {
		if (/^(?:AICHAT_.*|OPENCLAW_BIND|OPENCODE_SESSION_ID|CODEX_THREAD_ID)$/i.test(key)) delete env[key];
	}
	let child: CcChild;
	try {
		if (windows && !spawn) assertWindowsJobAvailable();
		child = (spawn ?? (windows ? spawnWindowsJob : nodeSpawn))(claudeBin, argv,
			{ cwd, env, detached: !windows, stdio: ['pipe', 'pipe', 'pipe'] });
	} catch { throw new Error('CC model inventory launch failed'); }

	return new Promise((resolve, reject) => {
		const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
		let pending = '', stdoutBytes = 0, stderrBytes = 0, submitted = false;
		let models: NativeModel[] | undefined, failure: string | undefined, settled = false;
		let close: { code: number | null; signal: string | null } | undefined;
		let retry: ReturnType<typeof setInterval> | undefined;
		const deadline = setTimeout(() => fail('deadline exceeded'), DEADLINE_MS);
		const onAbort = () => fail('aborted');
		const ownedPid = () => child.pid && child.pid > 0 && Number.isSafeInteger(child.pid) ? child.pid : undefined;

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
			else resolve(models!);
		}
		function confirmClose(): boolean {
			if (!close || !groupGone()) return false;
			const reason = failure ?? (!models || close.code !== 0 || close.signal !== null ? 'did not complete' : undefined);
			finish(reason ? new Error(`CC model inventory ${reason}`) : undefined);
			return true;
		}
		function fail(reason: string) {
			if (failure || settled) return;
			failure = reason;
			clearTimeout(deadline);
			pending = '';
			models = undefined;
			if (confirmClose()) return;
			const started = performance.now();
			let escalated = false;
			retry = setInterval(() => {
				if (confirmClose()) return;
				const elapsed = performance.now() - started;
				if (!escalated && elapsed >= KILL_GRACE_MS) {
					escalated = true;
					signalGroup('SIGKILL');
				}
				if (!settled && elapsed >= CLEANUP_MS) {
					if (child instanceof WindowsJobChild) child.forceKillHelper(); // Job kill-on-close; not proof.
					finish(new DriverDisconnectIncompleteError('CC model inventory cleanup unconfirmed'));
				}
			}, 20);
			signalGroup('SIGTERM');
		}
		function acceptLine(line: string) {
			if (!line.trim() || settled || failure) return;
			const frame = JSON.parse(line);
			const response = frame?.response;
			if (!submitted || models || frame?.type !== 'control_response' || response?.subtype !== 'success' ||
				response.request_id !== requestId) return fail('received an unexpected frame');
			const rows = response.response?.models;
			if (!Array.isArray(rows) || rows.length < 1 || rows.length > 256) return fail('returned invalid models');
			const projection: NativeModel[] = [];
			for (const row of rows) {
				if (!inventoryString(row?.value) || !inventoryString(row?.displayName)) return fail('returned invalid models');
				projection.push({ value: row.value, displayName: row.displayName });
			}
			models = projection;
			child.stdin!.end();
		}
		function initialize() {
			if (settled || failure || submitted) return;
			if (signal.aborted) return onAbort();
			if (!child.stdin || !child.stdout || !child.stderr) return fail('launch failed');
			submitted = true;
			try { child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'initialize' } })}\n`); }
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
				while (!failure && (newline = pending.indexOf('\n')) >= 0) {
					const line = pending.slice(0, newline);
					pending = pending.slice(newline + 1);
					acceptLine(line);
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
			child.once('spawn', initialize);
		} else if (child instanceof WindowsJobChild) {
			void child.ready.then(initialize, () => fail('launch failed'));
		} else initialize();
		if (signal.aborted) onAbort();
	});
}
