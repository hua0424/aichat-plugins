/**
 * REQ-010 S3 — `aichat list-friends` CLI.
 *
 * A THIN client (like send-message): resolves the agent session key OUT-OF-BAND from the env,
 * POSTs to the node-local loopback capability socket, prints the JSON result. No args — the friend
 * list is scoped by the resolved aiclaw token, never by a CLI argument.
 */

import { randomUUID } from 'node:crypto';
import { capabilitySocketPath } from '../capability/endpoint.js';
import { postCapability } from '../capability/client.js';
import { resolveAgentSessionKey } from './send-message.js';

export async function handleListFriends(_args: string[]): Promise<void> {
	const sessionKey = resolveAgentSessionKey();
	if (!sessionKey) {
		console.error('Error: no agent session env (OPENCODE_SESSION_ID)');
		process.exit(1);
	}

	const res = await postCapability(capabilitySocketPath(), {
		sessionKey,
		command: 'list-friends',
		args: {},
		idempotencyKey: randomUUID(),
	});

	const ok = res.status === 200 && (res.body as { ok?: boolean })?.ok === true;
	if (ok) {
		const result = (res.body as { result?: unknown }).result;
		console.log(JSON.stringify(result));
		return;
	}

	const error = (res.body as { error?: string })?.error ?? `HTTP ${res.status}`;
	console.error(`Error: list-friends failed: ${error}`);
	process.exit(1);
}
