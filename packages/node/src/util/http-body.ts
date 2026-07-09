import type { IncomingMessage } from 'node:http';

/**
 * Collect a loopback HTTP request body and JSON-parse it. Shared by the two node-local loopback servers
 * (the capability endpoint over a unix socket + the CC broker over 127.0.0.1). Empty body → `{}`; a parse
 * failure → `undefined` (the caller decides how to reject). Never throws.
 */
export function readJsonBody(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => {
			try {
				resolve(chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : {});
			} catch {
				resolve(undefined);
			}
		});
	});
}
