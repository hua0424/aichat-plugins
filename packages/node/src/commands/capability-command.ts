import { randomUUID } from 'node:crypto';
import { capabilitySocketPath } from '../capability/endpoint.js';
import { postCapability } from '../capability/client.js';
import { resolveAgentContexts } from './send-message.js';

/** All agent-facing capabilities share the V2 envelope and one machine-readable output contract. */
export async function runCapabilityCommand(
	command: string,
	argv: string[],
	legacy: (result: any) => string,
	write = false,
): Promise<void> {
	const json = argv.includes('--json');
	let requestId: string = command === 'send-message' ? `r${Date.now().toString(36)}.${randomUUID()}` : randomUUID();
	const args: Record<string, unknown> = {};
	const target = command === 'member-info' ? 'uid' : command === 'find-friend' ? 'keyword' : undefined;
	const accepted = new Set(command === 'send-message' ? ['--content', '--request-id', '--json'] :
		command === 'reset-session' ? ['--request-id', '--json'] :
		command === 'list-group-members' ? ['--online', '--groupid', '--json'] :
		target ? [`--${target}`, '--json'] : ['--json']);
	for (let i = 0; i < argv.length; i++) {
		const part = argv[i];
		if (part === '--json') continue;
		if (part === '--online') {
			if (!accepted.has(part)) return fail('INVALID_ARGUMENT', `${command}: unsupported option`, json, false);
			args.online = true;
			continue;
		}
		if (part.startsWith('--')) {
			if (!accepted.has(part)) return fail('INVALID_ARGUMENT', `${command}: unsupported option`, json, false);
			const value = argv[++i];
			if (!value || value.startsWith('--')) return fail('INVALID_ARGUMENT', `${command}: ${part} requires a value`, json, false);
			if (part === '--request-id') {
				if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) return fail('INVALID_ARGUMENT', '--request-id must be 1–128 ASCII letters, digits, dots, underscores, colons or hyphens', json, false);
				requestId = value;
			} else {
				const key = part.slice(2);
				if (key in args) return fail('INVALID_ARGUMENT', `${command}: repeated argument`, json, false);
				args[key] = value;
			}
		} else if (target && !(target in args)) args[target] = part;
		else return fail('INVALID_ARGUMENT', `${command}: unexpected argument`, json, false);
	}
	if (command === 'send-message') {
		if (typeof args.content !== 'string' || !args.content.trim()) return fail('INVALID_ARGUMENT', 'Usage: aichat send-message --content "<text>" [--request-id <id>]', json, false);
		args.content = args.content.trim();
	}
	if (target) {
		if (typeof args[target] !== 'string' || !args[target].trim() || (target === 'uid' && (!/^\d+$/.test(args[target] as string) || args[target] === '0')))
			return fail('INVALID_ARGUMENT', `Usage: aichat ${command} <${target}>`, json, false);
		if (target === 'keyword') args[target] = (args[target] as string).trim();
	}
	const contexts = resolveAgentContexts();
	if (!contexts.length) return fail('UNKNOWN_CONTEXT', 'no agent session env (AICHAT_CONTEXT_KEY / OPENCODE_SESSION_ID / CODEX_THREAD_ID / OPENCLAW_BIND / AICHAT_BIND)', json, false);
	let res: Awaited<ReturnType<typeof postCapability>>;
	try {
		res = await postCapability(capabilitySocketPath(), {
			version: 2, contexts, command, args, ...(write ? { requestId } : {}),
		});
	} catch {
		const code = write ? 'DELIVERY_UNKNOWN' : 'UPSTREAM_FAILED';
		return fail(code, write ? `${command} result unknown; retain --request-id ${requestId}; local node cannot confirm delivery, do not resend automatically` : `${command}: local capability endpoint unavailable`, json, !write, write ? requestId : undefined);
	}
	const body = res.body as { ok?: boolean; result?: any; code?: string; error?: string; retryable?: boolean } | null;
	if (res.status === 200 && body?.ok === true) {
		const result = body.result;
		if (command === 'send-message' && (!result || typeof result.msgId !== 'string' ||
			!/^\d+$/.test(result.msgId) || result.msgId === '0'))
			return fail('DELIVERY_UNKNOWN', `send-message result unknown; retain --request-id ${requestId} and identical content`, json, false, requestId);
		if (json && result && typeof result === 'object' && typeof result.error === 'string') {
			return fail(result.code ?? 'FORBIDDEN', result.error, true, result.retryable === true);
		}
		console.log(json ? JSON.stringify({ ok: true, result, ...(command === 'send-message' ? { requestId } : {}) }) : legacy(result));
		return;
	}
	const code = body?.code ?? (res.status === 403 ? 'FORBIDDEN' : res.status === 400 ? 'INVALID_ARGUMENT' : 'PERSISTENCE_FAILED');
	const message = write && code === 'DELIVERY_UNKNOWN'
		? `${command} result unknown; retain --request-id ${requestId} and identical content; ${typeof body?.error === 'string' && body.error.startsWith('server does not support durable receipts;')
			? 'server lacks durable receipts, do not retry automatically' : 'do not generate a new ID'}`
		: `${command} failed: ${body?.error ?? `HTTP ${res.status}`}`;
	return fail(code, message, json, body?.retryable === true, write && code === 'DELIVERY_UNKNOWN' ? requestId : undefined);
}

function fail(code: string, message: string, json: boolean, retryable: boolean, requestId?: string): never {
	if (json) console.log(JSON.stringify({ ok: false, code, message, retryable, ...(requestId ? { requestId } : {}) }));
	else console.error(`Error: ${message}${message.includes(code) ? '' : ` (${code})`}`);
	process.exit(1);
}
