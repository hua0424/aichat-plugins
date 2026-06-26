import { request } from 'node:http';

/**
 * REQ-010 S1 — tiny client for the node-local capability endpoint over a UNIX domain socket.
 *
 * The agent's `aichat send-message` CLI is a THIN client: it POSTs a JSON body to the loopback
 * socket and returns the status + parsed body. No business logic here — the endpoint is the tested
 * seam.
 */
/**
 * Default per-request timeout: a hung endpoint must never wedge the agent subprocess forever.
 *
 * REQ-010 S1: the server's POST /api/im/chat/msg measures ~5.5s, so the old 5s default fired ~0.5s
 * before the (successful) send returned. Raised to 30s (opencode's bash default is 120s, so 30s is
 * safe headroom) and overridable via AICHAT_CAPABILITY_TIMEOUT_MS for slower environments.
 */
const FALLBACK_TIMEOUT_MS = 30000;

/** Resolve the default timeout from env (AICHAT_CAPABILITY_TIMEOUT_MS), falling back when unset/NaN. */
function defaultTimeoutMs(): number {
	const raw = process.env.AICHAT_CAPABILITY_TIMEOUT_MS;
	if (raw === undefined) return FALLBACK_TIMEOUT_MS;
	const parsed = Number.parseInt(raw, 10);
	return Number.isNaN(parsed) ? FALLBACK_TIMEOUT_MS : parsed;
}

export function postCapability(
	socketPath: string,
	body: unknown,
	opts?: { timeoutMs?: number },
): Promise<{ status: number; body: unknown }> {
	const payload = JSON.stringify(body);
	// Injected opts.timeoutMs wins (tests, callers); otherwise env-or-30s default.
	const timeoutMs = opts?.timeoutMs ?? defaultTimeoutMs();
	return new Promise((resolve, reject) => {
		const req = request(
			{
				socketPath,
				path: '/',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(payload),
				},
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on('data', (c: Buffer) => chunks.push(c));
				res.on('end', () => {
					const text = Buffer.concat(chunks).toString('utf-8');
					let parsed: unknown;
					try {
						parsed = text.length > 0 ? JSON.parse(text) : {};
					} catch {
						parsed = { raw: text };
					}
					resolve({ status: res.statusCode ?? 0, body: parsed });
				});
			},
		);
		req.on('error', reject);
		// A connected-but-silent endpoint must not hang the agent. Tear the socket down and reject.
		req.setTimeout(timeoutMs, () => {
			req.destroy();
			reject(new Error('capability endpoint timeout'));
		});
		req.write(payload);
		req.end();
	});
}
