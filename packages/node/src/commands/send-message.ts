import { runCapabilityCommand } from './capability-command.js';
import { contextDescriptors } from '../capability/context-descriptors.js';

/** Reply only to the room/identity resolved by the node from the agent execution environment. */
export async function handleSendMessage(args: string[]): Promise<void> {
	return runCapabilityCommand('send-message', args, (result) => `Message sent: ${JSON.stringify({ msgId: result.msgId, ...(result.roomId === undefined ? {} : { roomId: result.roomId }) })}`, true);
}

/** Descriptor-only candidate collection: no SDK, registry, backend or other identity credentials. */
export function resolveAgentContexts(env: NodeJS.ProcessEnv = process.env): Array<{ key: string } | { provider: string; nativeId: string }> {
	const contexts: Array<{ key: string } | { provider: string; nativeId: string }> = [];
	if (env.AICHAT_CONTEXT_KEY) contexts.push({ key: env.AICHAT_CONTEXT_KEY });
	for (const { env: name, provider } of contextDescriptors) {
		if (env[name]) contexts.push({ provider, nativeId: env[name] });
	}
	return contexts;
}

/**
 * #404: frozen per-run reply-binding token for the V3 envelope. Present only inside a trusted
 * native run env (drivers inject exactly one); an old CLI ignores it and stays V2 (unassociated).
 */
export function resolveRunBind(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const raw = env.AICHAT_RUN_BIND;
	if (raw === undefined) return undefined;
	const token = raw.trim();
	return token ? token : undefined;
}

/** Legacy single-key accessor retained for old callers; V2 requests use every candidate above. */
export function resolveAgentSessionKey(): string | undefined {
	for (const { env, provider } of contextDescriptors) {
		if (process.env[env]) return `${provider}:${process.env[env]}`;
	}
	return undefined;
}
