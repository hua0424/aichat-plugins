/**
 * aichatoverview#124 — `aichat reset-session` CLI.
 *
 * A THIN client run BY an operator inside an agent-bound session env. It takes NO flags: the target
 * room + identity are NEVER passed on the command line — node resolves them from the agent's session
 * env var (anti-spoofing), exactly like `send-message`. The agent runtime injects an opaque
 * context key; setting a plaintext uid/room binding cannot select another conversation.
 * The command POSTs to the node-local capability socket and rotates that conversation's history.
 * An unconfirmed old execution remains paused even after reset. Other rooms are unaffected.
 */

import { randomUUID } from 'node:crypto';
import { capabilitySocketPath } from '../capability/endpoint.js';
import { postCapability } from '../capability/client.js';
import { resolveAgentContexts } from './send-message.js';

export async function handleResetSession(args: string[]): Promise<void> {
	let requestId: string = randomUUID();
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--request-id') {
			const id = args[++i];
			if (!id || id.startsWith('--') || id.length > 128 || !id.trim()) {
				console.error('Error: --request-id requires a non-empty value (max 128 characters)');
				process.exit(1);
			}
			requestId = id;
		}
	}
	const contexts = resolveAgentContexts();
	if (!contexts.length) {
		console.error('Error: no agent session env (OPENCODE_SESSION_ID / CODEX_THREAD_ID / OPENCLAW_BIND / AICHAT_BIND)');
		process.exit(1);
	}

	let res: Awaited<ReturnType<typeof postCapability>>;
	try {
		res = await postCapability(capabilitySocketPath(), {
			version: 2, contexts,
			command: 'reset-session',
			args: {},
			requestId,
		});
	} catch {
		console.error(`Error: reset-session result unknown (DELIVERY_UNKNOWN); retain --request-id ${requestId}; local node cannot confirm an unknown result, do not reset automatically`);
		process.exit(1);
	}

	const ok = res.status === 200 && (res.body as { ok?: boolean })?.ok === true;
	if (ok) {
		const result = (res.body as { result?: { roomId?: string; driverType?: string; reset?: boolean; executionPaused?: boolean } }).result ?? {};
		if (result.reset === true) {
			console.log(result.executionPaused
				? `会话已重置：room ${result.roomId}（driver=${result.driverType}），旧任务停止未确认，执行仍暂停。`
				: `会话已重置：room ${result.roomId}（driver=${result.driverType}），下一条消息将开启全新会话（上下文已清空）。`);
		} else {
			console.log(`no-op：driver=${result.driverType} 无按房会话态（binding 即会话，无持久上下文），无需 reset。`);
		}
		return;
	}

	const error = (res.body as { error?: string })?.error ?? `HTTP ${res.status}`;
	console.error(`Error: reset-session failed: ${error}${(res.body as { code?: string })?.code === 'DELIVERY_UNKNOWN' ? ` (DELIVERY_UNKNOWN; retain --request-id ${requestId}; local node cannot confirm an unknown result, do not reset automatically)` : ''}`);
	process.exit(1);
}
