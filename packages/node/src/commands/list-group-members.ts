/**
 * REQ-010 S4 — `aichat list-group-members [--online] [--groupid <id>]` CLI.
 *
 * A THIN client (like find-friend): resolves the agent session key OUT-OF-BAND from the env, POSTs
 * to the node-local loopback capability socket, prints the JSON result. No identity args — `--groupid`
 * is only a QUERY TARGET (a room the agent names); the server enforces that this aiclaw joined it.
 */

import { randomUUID } from 'node:crypto';
import { capabilitySocketPath } from '../capability/endpoint.js';
import { postCapability } from '../capability/client.js';
import { resolveAgentSessionKey } from './send-message.js';

export async function handleListGroupMembers(args: string[]): Promise<void> {
	let online = false;
	let groupid = '';
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--online') online = true;
		else if (args[i] === '--groupid' && args[i + 1]) groupid = args[++i];
	}

	const sessionKey = resolveAgentSessionKey();
	if (!sessionKey) {
		console.error('Error: no agent session env (OPENCODE_SESSION_ID)');
		process.exit(1);
	}

	const res = await postCapability(capabilitySocketPath(), {
		sessionKey,
		command: 'list-group-members',
		args: {
			...(online ? { online: true } : {}),
			...(groupid ? { groupid } : {}),
		},
		idempotencyKey: randomUUID(),
	});

	const ok = res.status === 200 && (res.body as { ok?: boolean })?.ok === true;
	if (ok) {
		const result = (res.body as { result?: unknown }).result;
		console.log(JSON.stringify(result));
		return;
	}

	const error = (res.body as { error?: string })?.error ?? `HTTP ${res.status}`;
	console.error(`Error: list-group-members failed: ${error}`);
	process.exit(1);
}
