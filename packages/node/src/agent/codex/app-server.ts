import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';

/** The pinned native protocol, not an SDK exec stream. No retry/reconnect of mutations. */
export class CodexAppServer {
	private child?: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
	private readonly listeners = new Set<(method: string, params: unknown) => void>();
	private readonly closeListeners = new Set<() => void>();
	/** Explicit journal IDs remain tombstones after timeout; a late native reply must never match a replay. */
	private readonly coreRequestIds = new Set<string>();
	private startPromise?: Promise<void>;
	private closed = false;
	constructor(private readonly options: {
		command: string; prefix?: string[]; args?: string[]; env: NodeJS.ProcessEnv;
		timeoutMs?: number;
	}) {}

	onNotification(listener: (method: string, params: unknown) => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	onClose(listener: () => void): () => void {
		this.closeListeners.add(listener);
		return () => { this.closeListeners.delete(listener); };
	}

	start(): Promise<void> {
		return this.startPromise ??= this.initialize().catch((error) => { this.fail('CODEX_CHANNEL_FAILED'); throw error; });
	}

	private async initialize(): Promise<void> {
		// Checking initialize.userAgent alone is insufficient: it also includes client metadata.
		await this.checkVersion();
		if (this.closed) throw new Error('CODEX_CHANNEL_CLOSED');
		const child = spawn(this.options.command, [...(this.options.prefix ?? []), 'app-server', '--stdio', ...(this.options.args ?? [])],
			{ env: this.options.env, stdio: 'pipe', windowsHide: true });
		this.child = child;
		const decoder = new StringDecoder('utf8');
		let buffered = '';
		child.stdout.on('data', (chunk: Buffer) => {
			buffered += decoder.write(chunk);
			// Bounded protocol framing; never log stdout/stderr (they can contain credentials).
			if (buffered.length > 16 * 1024 * 1024) { this.fail('CODEX_PROTOCOL_FRAME_TOO_LARGE'); return; }
			let end: number;
			while ((end = buffered.indexOf('\n')) !== -1) {
				const line = buffered.slice(0, end).trim();
				buffered = buffered.slice(end + 1);
				if (!line) continue;
				try { this.receive(JSON.parse(line)); }
				catch { this.fail('CODEX_PROTOCOL_INVALID'); return; }
			}
		});
		child.stderr.resume();
		child.stdin.on('error', () => this.fail('CODEX_CHANNEL_FAILED'));
		child.on('error', () => this.fail('CODEX_CHANNEL_FAILED'));
		child.on('close', () => this.fail('CODEX_CHANNEL_CLOSED'));
		await this.request('initialize', { clientInfo: { name: 'aichat', version: '1' }, capabilities: { experimentalApi: true } });
		this.notify('initialized', {});
	}

	private checkVersion(): Promise<void> {
		return new Promise((resolve, reject) => {
			const child = spawn(this.options.command, [...(this.options.prefix ?? []), '--version'],
				{ env: this.options.env, stdio: 'pipe', windowsHide: true });
			let output = '';
			const timer = setTimeout(() => { child.kill(); reject(new Error('CODEX_VERSION_UNVERIFIED')); }, this.options.timeoutMs ?? 15_000);
			child.stdout.on('data', (chunk: Buffer) => {
				output += chunk.toString('utf8');
				if (output.length > 1024) { child.kill(); output = ''; }
			});
			child.stderr.resume();
			child.once('error', () => { clearTimeout(timer); reject(new Error('CODEX_VERSION_UNVERIFIED')); });
			child.once('close', (code) => {
				clearTimeout(timer);
				if (code === 0 && output.trim() === 'codex-cli 0.142.3') resolve();
				else reject(new Error('CODEX_VERSION_UNVERIFIED: requires codex-cli 0.142.3'));
			});
		});
	}

	request(method: string, params: unknown, coreRequestId?: string): Promise<unknown> {
		if (this.closed || !this.child) return Promise.reject(new Error('CODEX_CHANNEL_CLOSED'));
		const id = coreRequestId ?? randomUUID();
		if (!id || this.pending.has(id) || this.coreRequestIds.has(id)) return Promise.reject(new Error('CODEX_REQUEST_ID_CONFLICT'));
		if (coreRequestId !== undefined) this.coreRequestIds.add(id);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error('CODEX_RESULT_UNKNOWN: native response deadline elapsed; do not resubmit'));
			}, this.options.timeoutMs ?? 15_000);
			this.pending.set(id, { resolve, reject, timer });
			this.child!.stdin.write(JSON.stringify({ id, method, params }) + '\n', (error) => {
				if (error) this.fail('CODEX_RESULT_UNKNOWN: native channel write failed; do not resubmit');
			});
		});
	}

	private notify(method: string, params: unknown): void {
		if (this.closed || !this.child) throw new Error('CODEX_CHANNEL_CLOSED');
		this.child.stdin.write(JSON.stringify({ method, params }) + '\n');
	}

	private receive(message: unknown): void {
		if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('invalid frame');
		const frame = message as Record<string, unknown>;
		if (typeof frame.method === 'string') {
			if ('id' in frame) {
				// Never auto-approve server-initiated permission/tool requests.
				this.child!.stdin.write(JSON.stringify({ id: frame.id, error: { code: -32601, message: 'Unsupported client request' } }) + '\n');
				return;
			}
			for (const listener of this.listeners) listener(frame.method, frame.params);
			return;
		}
		if (typeof frame.id !== 'string') throw new Error('invalid response id');
		const pending = this.pending.get(frame.id);
		if (!pending) return; // late/duplicate responses never complete a different request
		if (('result' in frame) === ('error' in frame)) throw new Error('invalid response');
		this.pending.delete(frame.id);
		clearTimeout(pending.timer);
		if ('error' in frame) pending.reject(new Error('CODEX_NATIVE_REQUEST_FAILED'));
		else pending.resolve(frame.result);
	}

	private fail(reason: string): void {
		if (this.closed) return;
		this.closed = true;
		for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(reason)); }
		this.pending.clear();
		this.child?.kill();
		for (const listener of this.closeListeners) listener();
	}

	/** Child exit is not proof that its native background process tree has stopped. */
	close(): void { this.fail('CODEX_CHANNEL_CLOSED'); }
}
