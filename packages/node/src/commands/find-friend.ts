/**
 * REQ-010 S3 — `aichat find-friend <keyword>` CLI.
 *
 * A THIN client (like send-message): resolves the agent session key OUT-OF-BAND from the env,
 * POSTs to the node-local loopback capability socket, prints the JSON result. Identity/scope are
 * NEVER passed on the command line — only the QUERY TARGET `keyword` is an argument.
 */

import { randomUUID } from 'node:crypto';
import { capabilitySocketPath } from '../capability/endpoint.js';
import { postCapability } from '../capability/client.js';
import { resolveAgentSessionKey } from './send-message.js';

export async function handleFindFriend(args: string[]): Promise<void> {
	let keyword = '';
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--keyword' && args[i + 1]) keyword = args[++i];
		else if (!args[i].startsWith('--') && !keyword) keyword = args[i];
	}

	if (!keyword.trim()) {
		console.error('Usage: aichat find-friend <keyword>');
		process.exit(1);
	}

	const sessionKey = resolveAgentSessionKey();
	if (!sessionKey) {
		console.error('Error: no agent session env (OPENCODE_SESSION_ID)');
		process.exit(1);
	}

	const res = await postCapability(capabilitySocketPath(), {
		sessionKey,
		command: 'find-friend',
		args: { keyword: keyword.trim() },
		idempotencyKey: randomUUID(),
	});

	const ok = res.status === 200 && (res.body as { ok?: boolean })?.ok === true;
	if (ok) {
		const result = (res.body as { result?: unknown }).result;
		console.log(JSON.stringify(result));
		return;
	}

	const error = (res.body as { error?: string })?.error ?? `HTTP ${res.status}`;
	console.error(`Error: find-friend failed: ${error}`);
	process.exit(1);
}
