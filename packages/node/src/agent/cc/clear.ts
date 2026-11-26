import { randomUUID } from 'node:crypto';
import { runCcControlChild } from './control-child.js';
import type { CcKillFn, CcSpawnFn } from './headless-driver.js';

const nativeId = (value: unknown): value is string => typeof value === 'string' &&
	/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
const hasNoTokens = (usage: unknown): boolean => typeof usage === 'object' && usage !== null &&
	'input_tokens' in usage && usage.input_tokens === 0 && 'output_tokens' in usage && usage.output_tokens === 0;
const MAX_HISTORY_BYTES = 8 * 1024 * 1024;
const clearEnvelope = /^<command-name>\/clear<\/command-name>\s*<command-message>clear<\/command-message>\s*<command-args><\/command-args>$/;

/** Validate already sealed snapshots. The caller must prove both file identities and fresh creation. */
export function verifyCcClearHistory({ cwd, oldSessionId, newSessionId, outputId, oldBefore, oldAfter, newHistory, oldModeAlreadyAppended = false }: {
	cwd: string; oldSessionId: string; newSessionId: string; outputId: string;
	oldBefore: Buffer; oldAfter: Buffer; newHistory: Buffer; oldModeAlreadyAppended?: boolean;
}): boolean {
	if (![oldSessionId, newSessionId, outputId].every(nativeId) ||
		new Set([oldSessionId, newSessionId, outputId].map((id) => id.toLowerCase())).size !== 3 ||
		oldBefore.at(-1) !== 10 || oldAfter.length > MAX_HISTORY_BYTES || newHistory.length > 16 * 1024 ||
		!oldAfter.subarray(0, oldBefore.length).equals(oldBefore) || newHistory.at(-1) !== 10) return false;
	const rows = (bytes: Buffer) => {
		if (!bytes.length) return [];
		if (bytes.at(-1) !== 10) throw new Error('incomplete history');
		return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
			.decode(bytes.subarray(0, -1)).split('\n').map(line => JSON.parse(line));
	};
	const isMode = (row: unknown, id: string) => JSON.stringify(row) === JSON.stringify({ type: 'mode', mode: 'normal', sessionId: id });
	try {
		const oldSuffix = rows(oldAfter.subarray(oldBefore.length));
		if (oldSuffix.length > 3 || !oldSuffix.every(row => (!oldModeAlreadyAppended && isMode(row, oldSessionId)) ||
			(row?.type === 'queue-operation' && row.sessionId === oldSessionId &&
				Object.keys(row).every(key => ['type', 'operation', 'content', 'sessionId', 'timestamp'].includes(key)) &&
				((row.operation === 'enqueue' && (row.content === undefined || row.content === '/clear')) ||
					(row.operation === 'dequeue' && row.content === undefined)))) ||
			new Set(oldSuffix.map(row => row.type === 'mode' ? 'mode' : row.operation)).size !== oldSuffix.length) return false;
		const next = rows(newHistory);
		if (isMode(next[0], newSessionId)) next.shift();
		if (JSON.stringify(next.at(-1)) === JSON.stringify({ type: 'last-prompt', leafUuid: outputId, sessionId: newSessionId })) next.pop();
		const [caveat, command, output] = next;
		if (next.length !== 3 || !next.every(row => row?.cwd === cwd && row.version === '2.1.195' && row.isSidechain === false &&
			row.sessionId === newSessionId && nativeId(row.uuid) && row.uuid !== newSessionId && !oldBefore.includes(row.uuid)) ||
			new Set(next.map(row => row.uuid.toLowerCase())).size !== 3) return false;
		return caveat.type === 'user' && caveat.parentUuid === null && caveat.isMeta === true && caveat.message?.role === 'user' &&
			typeof caveat.message.content === 'string' && caveat.message.content.startsWith('<local-command-caveat>') &&
			caveat.message.content.endsWith('</local-command-caveat>') && command.type === 'user' && command.isMeta !== true &&
			command.parentUuid === caveat.uuid && command.message?.role === 'user' && typeof command.message.content === 'string' &&
			clearEnvelope.test(command.message.content.trim()) && output.type === 'system' && output.subtype === 'local_command' &&
			output.level === 'info' && output.isMeta === false && output.parentUuid === command.uuid && output.uuid === outputId &&
			output.content === '<local-command-stdout></local-command-stdout>';
	} catch { return false; }
}

/** The observed native ID is not yet proof that a later ordinary child can open that conversation. */
export async function observeCcClear({ cwd, sessionId, inputId, claudeBin, settingsPath, env, signal, beforeInput, onSubmit, spawn, kill, platform }: {
	cwd: string; sessionId: string; inputId: string; claudeBin: string; settingsPath: string; env: NodeJS.ProcessEnv; signal: AbortSignal;
	beforeInput(): Promise<void>; onSubmit(): void; spawn?: CcSpawnFn; kill?: CcKillFn; platform?: NodeJS.Platform;
}): Promise<{ observedSessionId: string; outputId: string }> {
	if (!nativeId(sessionId) || !nativeId(inputId) || inputId.toLowerCase() === sessionId.toLowerCase())
		throw new Error('CC clear requires original native session and input IDs');
	if (Object.keys(env).some(key => /^(?:AICHAT_.*|OPENCLAW_BIND|OPENCODE_SESSION_ID|CODEX_THREAD_ID)$/i.test(key)))
		throw new Error('CC clear cannot inherit reply authority');
	const initializeId = randomUUID();
	let phase: 'initialize' | 'checking' | 'input' = 'initialize';
	let originalInit = false;
	let observedSessionId: string | undefined, outputId: string | undefined;
	return runCcControlChild<{ observedSessionId: string; outputId: string }>({ label: 'clear', cwd, signal, claudeBin, spawn, kill, platform,
		argv: ['-p', '--resume', sessionId, '--settings', settingsPath, '--safe-mode', '--input-format', 'stream-json',
			'--output-format', 'stream-json', '--verbose', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--max-turns', '1'],
		env, deadlineMs: 35_000,
		initialize: (io) => io.write({ type: 'control_request', request_id: initializeId, request: { subtype: 'initialize' } }),
		onLine(line, io) {
			const m = JSON.parse(line);
			const unconfirmed = () => io.fail('native clear transition unconfirmed');
			if (phase === 'initialize') {
				if (m?.type !== 'control_response' || m.response?.subtype !== 'success' || m.response.request_id !== initializeId)
					return unconfirmed();
				phase = 'checking';
				void beforeInput().then(() => io.write({ type: 'user', uuid: inputId, session_id: sessionId, parent_tool_use_id: null,
					message: { role: 'user', content: [{ type: 'text', text: '/clear' }] } }, () => {
					onSubmit();
					phase = 'input';
				})).catch(() => io.fail('original history changed'));
				return;
			}
			if (phase !== 'input' || !nativeId(m?.session_id)) return unconfirmed();
			if (m.type === 'system' && m.subtype === 'init') {
				if (observedSessionId || m.cwd !== cwd || m.claude_code_version !== '2.1.195' || m.permissionMode === 'bypassPermissions' ||
					!Array.isArray(m.tools) || m.tools.length || !Array.isArray(m.mcp_servers) || m.mcp_servers.length) return unconfirmed();
				const id = m.session_id.toLowerCase();
				if (id === sessionId.toLowerCase()) {
					if (originalInit) return unconfirmed();
					originalInit = true;
					return;
				}
				if (id === inputId.toLowerCase() || id === initializeId) return unconfirmed();
				observedSessionId = m.session_id;
				return;
			}
			if (!observedSessionId || m.session_id !== observedSessionId) return unconfirmed();
			const content = m.message?.content;
			if (m.type === 'assistant' && !outputId && nativeId(m.uuid) &&
				![initializeId, sessionId, inputId, observedSessionId].some(id => m.uuid.toLowerCase() === id.toLowerCase()) &&
				m.parent_tool_use_id === null && m.message?.role === 'assistant' &&
				m.message.model === '<synthetic>' && hasNoTokens(m.message.usage) && Array.isArray(content) && content.length === 1 &&
				content[0]?.type === 'text' && content[0].text === '(no content)') { outputId = m.uuid; return; }
			// Some totals (e.g. duration_api_ms/modelUsage) are cumulative, even for a local command.
			if (outputId && m.type === 'result' && m.subtype === 'success' && m.is_error === false && m.num_turns === 0 &&
				m.result === '' && hasNoTokens(m.usage) && Array.isArray(m.permission_denials) && !m.permission_denials.length) {
				io.complete({ observedSessionId, outputId });
				return;
			}
			unconfirmed();
		},
	});
}
