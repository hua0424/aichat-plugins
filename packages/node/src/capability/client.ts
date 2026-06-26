import { request } from 'node:http';

/**
 * REQ-010 S1 — tiny client for the node-local capability endpoint over a UNIX domain socket.
 *
 * The agent's `aichat send-message` CLI is a THIN client: it POSTs a JSON body to the loopback
 * socket and returns the status + parsed body. No business logic here — the endpoint is the tested
 * seam.
 */
/** Default per-request timeout: a hung endpoint must never wedge the agent subprocess forever. */
const DEFAULT_TIMEOUT_MS = 5000;

export function postCapability(
	socketPath: string,
	body: unknown,
	opts?: { timeoutMs?: number },
): Promise<{ status: number; body: unknown }> {
	const payload = JSON.stringify(body);
	const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
