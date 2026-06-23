import { createOpencodeServer, createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';

/** A started opencode server handle (the subset we depend on). */
export interface OpencodeServerHandle {
	url: string;
	close(): void;
}

/** Options passed to the injected server starter. */
export interface StartServerOpts {
	hostname?: string;
	port?: number;
	/**
	 * REQ-008 #78: opencode server `config` (the subset we use). `plugin` is the list of
	 * module paths the spawned `opencode serve` loads — we inject the built hula plugin here so
	 * the agent can call hula_send_message / hula_skip_reply.
	 */
	config?: { plugin?: string[] };
}

/**
 * Injectable dependency surface so the manager is unit-testable without a real server.
 * Default deps (see `defaultServerManagerDeps`) wire the real SDK.
 */
export interface OpencodeServerManagerDeps {
	startServer: (opts: StartServerOpts) => Promise<OpencodeServerHandle>;
	makeClient: (baseUrl: string) => OpencodeClient;
	/** Whether ensureStarted requires OPENCODE_SERVER_PASSWORD in env (default true). */
	requirePassword?: boolean;
}

/** REQ-008: opencode serve enforces HTTP Basic auth (user "opencode" + OPENCODE_SERVER_PASSWORD).
 * Returns the Authorization header value, or undefined when no password is set. */
export function opencodeBasicAuthHeader(password: string | undefined): string | undefined {
	if (!password) return undefined;
	return 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64');
}

/** Real deps wiring @opencode-ai/sdk. */
export function defaultServerManagerDeps(): OpencodeServerManagerDeps {
	return {
		startServer: (opts) => createOpencodeServer(opts),
		makeClient: (baseUrl) => {
			const auth = opencodeBasicAuthHeader(process.env.OPENCODE_SERVER_PASSWORD);
			return createOpencodeClient({ baseUrl, ...(auth ? { headers: { Authorization: auth } } : {}) });
		},
		requirePassword: true,
	};
}

/**
 * REQ-008 #77 — "1 shared opencode server serves N identities".
 *
 * One process runs a single opencode server; every aiclaw identity / workspace directory
 * is served by the SAME server (sessions are scoped by a `directory` query param, not by
 * a per-identity server). This class owns that single server's lifecycle: lazy idempotent
 * start, crash-recovery restart, and stop. Sessions are (re)established lazily by callers
 * after a restart — the manager does not track them.
 */
export class OpencodeServerManager {
	private server: OpencodeServerHandle | null = null;
	private client: OpencodeClient | null = null;
	/** In-flight start promise so concurrent ensureStarted() callers await the same start. */
	private starting: Promise<void> | null = null;

	private readonly requirePassword: boolean;
	/** REQ-008 #78: module paths of opencode plugins to load into the spawned server. */
	private readonly pluginPaths: string[];

	constructor(
		private readonly deps: OpencodeServerManagerDeps,
		opts?: { pluginPaths?: string[] },
	) {
		this.requirePassword = deps.requirePassword ?? true;
		this.pluginPaths = opts?.pluginPaths ?? [];
	}

	/** True once a server has started and not been stopped. */
	get started(): boolean {
		return this.server !== null;
	}

	/**
	 * Lazy + idempotent start. Concurrent callers share the same in-flight start.
	 * Throws if OPENCODE_SERVER_PASSWORD is required but unset — we never run an
	 * unprotected server.
	 */
	async ensureStarted(): Promise<void> {
		if (this.server) return;
		if (this.starting) return this.starting;

		this.starting = this.doStart().finally(() => {
			this.starting = null;
		});
		return this.starting;
	}

	private async doStart(): Promise<void> {
		if (this.requirePassword && !process.env.OPENCODE_SERVER_PASSWORD) {
			throw new Error('OPENCODE_SERVER_PASSWORD must be set');
		}
		// REQ-008 #78: inject the configured plugin module paths into the spawned server's config
		// so the agent can call the hula terminal tools. Empty list → omit config.plugin entirely.
		const opts: StartServerOpts = this.pluginPaths.length > 0 ? { config: { plugin: this.pluginPaths } } : {};
		const handle = await this.deps.startServer(opts);
		this.server = handle;
		this.client = this.deps.makeClient(handle.url);
	}

	/** The shared client. Throws if the server has not started yet. */
	getClient(): OpencodeClient {
		if (!this.client) {
			throw new Error('opencode server not started; call ensureStarted() first');
		}
		return this.client;
	}

	/** The started server's base URL. Throws if not started. */
	get url(): string {
		if (!this.server) {
			throw new Error('opencode server not started; call ensureStarted() first');
		}
		return this.server.url;
	}

	/**
	 * Crash recovery: close the current server and start a fresh one. Callers re-establish
	 * their sessions lazily afterward (the manager does not persist/track sessions).
	 */
	async restart(): Promise<void> {
		await this.stop();
		await this.ensureStarted();
	}

	/** Stop the server (best-effort close). Idempotent. */
	async stop(): Promise<void> {
		const handle = this.server;
		this.server = null;
		this.client = null;
		if (handle) {
			try {
				handle.close();
			} catch {
				/* best-effort */
			}
		}
	}
}
