/**
 * REQ-010 S7 — `aichat cc-bind --room <roomId> [--uid <ccUid>]` CLI.
 *
 * claude-code (CC) has NO server: the OWNER runs `claude` by hand. This command asks the running node
 * for the copy-paste launch command bound to a room (only the node knows the resolved cc aiclaw uid).
 * It POSTs `{ admin: "cc-bind", roomId, uid? }` to the node-local loopback capability socket (the
 * `cc-bind` admin route, NOT identity-resolved). It prints the launchCommand the owner pastes to start
 * CC bound to that room.
 */

import { capabilitySocketPath } from '../capability/endpoint.js';
import { postCapability } from '../capability/client.js';

export async function handleCcBind(args: string[]): Promise<void> {
	let room = '';
	let uid = '';
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--room' && args[i + 1]) room = args[++i];
		else if (args[i] === '--uid' && args[i + 1]) uid = args[++i];
	}

	const roomId = Number(room);
	if (!Number.isInteger(roomId) || roomId <= 0) {
		console.error('Usage: aichat cc-bind --room <roomId> [--uid <ccUid>]');
		console.error('       (asks the running node for the CC launch command bound to <roomId>)');
		process.exit(1);
	}

	const res = await postCapability(capabilitySocketPath(), {
		admin: 'cc-bind',
		roomId,
		...(uid ? { uid: Number(uid) } : {}),
	});

	const ok = res.status === 200 && (res.body as { ok?: boolean })?.ok === true;
	if (!ok) {
		const error = (res.body as { error?: string })?.error ?? `HTTP ${res.status}`;
		console.error(`Error: cc-bind failed: ${error}`);
		process.exit(1);
	}

	const result = (res.body as { result?: { launchCommand?: string; workspaceDir?: string } }).result ?? {};
	console.log(`Run this to start CC bound to room ${roomId}:`);
	console.log('');
	console.log(`  ${result.launchCommand}`);
	console.log('');
	if (result.workspaceDir) console.log(`Workspace: ${result.workspaceDir}`);
}
