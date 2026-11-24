import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath, type FileHandle } from 'node:fs/promises';
import { basename } from 'node:path';
import { runCcControlChild } from './control-child.js';
import type { CcKillFn, CcSpawnFn } from './headless-driver.js';

const nativeId = (value: unknown): value is string => typeof value === 'string' &&
	/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
const tokens = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const summaryText = (content: unknown): string | undefined => {
	if (typeof content === 'string') return content;
	if (Array.isArray(content) && content.length === 1 && content[0]?.type === 'text' && typeof content[0].text === 'string') return content[0].text;
};

type CompactBoundary = { controlId: string; preTokens: number; postTokens?: number };
export type ObservedCcCompact = CompactBoundary & { summaryId: string; summaryHash: string };

const MAX_HISTORY_BYTES = 8 * 1024 * 1024;

/** Read only the original file. A replacement, rewrite, or partial append is not effect evidence. */
export async function verifyCcCompactAppend({ handle, path, original, sessionId, cwd, version, evidence }: {
	handle: FileHandle; path: string; original: Buffer; sessionId: string; cwd: string; version: '2.1.195'; evidence: ObservedCcCompact;
}): Promise<void> {
	const unconfirmed = () => new Error('CC durable compact effect unconfirmed');
	try {
		if (!nativeId(sessionId) || basename(path) !== `${sessionId}.jsonl` || !original.length || original.at(-1) !== 10) throw unconfirmed();
		const before = await handle.stat();
		const sameFile = async () => {
			const named = await lstat(path);
			return named.isFile() && named.nlink === 1 && named.dev === before.dev && named.ino === before.ino && await realpath(path) === path;
		};
		if (!before.isFile() || before.nlink !== 1 || before.size <= original.length || before.size > MAX_HISTORY_BYTES || !await sameFile()) throw unconfirmed();
		const bytes = Buffer.alloc(before.size);
		let offset = 0;
		while (offset < bytes.length) {
			const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
			if (!bytesRead) throw unconfirmed();
			offset += bytesRead;
		}
		const after = await handle.stat();
		if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || !await sameFile() ||
			!bytes.subarray(0, original.length).equals(original) || bytes.at(-1) !== 10 ||
			original.includes(evidence.controlId) || original.includes(evidence.summaryId)) throw unconfirmed();
		const appended = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(original.length));
		const rows = appended.trimEnd().split('\n').map(line => JSON.parse(line));
		const boundaries = rows.filter(m => m?.type === 'system' && m.subtype === 'compact_boundary');
		const summaries = rows.filter(m => m?.type === 'user' && m.isCompactSummary === true);
		const [boundary] = boundaries, [summary] = summaries;
		if (boundaries.length !== 1 || summaries.length !== 1 || rows.indexOf(boundary) >= rows.indexOf(summary) ||
			![boundary, summary].every(m => m.sessionId === sessionId && m.cwd === cwd && m.version === version && m.isSidechain === false) ||
			boundary.uuid !== evidence.controlId || boundary.compactMetadata?.trigger !== 'manual' ||
			boundary.compactMetadata.preTokens !== evidence.preTokens || boundary.compactMetadata.postTokens !== evidence.postTokens ||
			summary.uuid !== evidence.summaryId || summary.parentUuid !== boundary.uuid || summary.message?.role !== 'user' ||
			createHash('sha256').update(summaryText(summary.message.content) ?? '').digest('hex') !== evidence.summaryHash) throw unconfirmed();
	} catch { throw unconfirmed(); }
}

/** Observe one owned native compact. The caller must reserve and verify the scope and durable native history separately. */
export async function observeCcCompact({ cwd, sessionId, inputId, version, claudeBin, settingsPath, env, signal,
	assertCurrent, spawn, kill, platform }: { cwd: string; sessionId: string; inputId: string; version: '2.1.195';
	claudeBin: string; settingsPath: string; env: NodeJS.ProcessEnv; signal: AbortSignal;
	assertCurrent(): void; spawn?: CcSpawnFn; kill?: CcKillFn; platform?: NodeJS.Platform;
}): Promise<ObservedCcCompact> {
	if (!nativeId(sessionId) || !nativeId(inputId) || inputId === sessionId)
		throw new Error('CC compact requires original native session and input IDs');
	if (Object.keys(env).some(key => /^(?:AICHAT_.*|OPENCLAW_BIND|OPENCODE_SESSION_ID|CODEX_THREAD_ID)$/i.test(key)))
		throw new Error('CC compact cannot inherit reply authority');
	const initializeId = randomUUID();
	let phase: 'initialize' | 'input' | 'effect' = 'initialize';
	let boundary: CompactBoundary | undefined;
	let nativeSummary: { summaryId: string; summaryHash: string } | undefined;
	let displaySeen = false;
	assertCurrent();
	return runCcControlChild<ObservedCcCompact>({ label: 'compact', cwd, signal, claudeBin, spawn, kill, platform,
		argv: ['-p', '--resume', sessionId, '--settings', settingsPath, '--safe-mode', '--input-format', 'stream-json',
			'--output-format', 'stream-json', '--verbose', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--max-turns', '1'],
		env, deadlineMs: 5 * 60_000,
		initialize: (io) => io.write({ type: 'control_request', request_id: initializeId, request: { subtype: 'initialize' } }),
		onLine(line, io) {
			const m = JSON.parse(line);
			if (phase === 'initialize') {
				if (m?.type !== 'control_response' || m.response?.subtype !== 'success' || m.response.request_id !== initializeId)
					return io.fail('unexpected initialize response');
				try { assertCurrent(); }
				catch { return io.fail('original scope changed'); }
				phase = 'input';
				io.write({ type: 'user', uuid: inputId, session_id: sessionId, parent_tool_use_id: null,
					message: { role: 'user', content: [{ type: 'text', text: '/compact' }] } });
				return;
			}
			const unconfirmed = () => io.fail('native compact effect unconfirmed');
			if (m?.session_id !== sessionId) return unconfirmed();
			// Pinned Claude emits compact progress even before its per-input init; it proves no effect.
			if (m.type === 'system' && m.subtype === 'status' &&
				(m.status === 'compacting' && m.compact_result === undefined ||
					m.status === null && (m.compact_result === undefined || m.compact_result === 'success'))) return;
			if (phase === 'input') {
				if (m.type !== 'system' || m.subtype !== 'init' || m.cwd !== cwd || m.claude_code_version !== version ||
					m.permissionMode === 'bypassPermissions' || !Array.isArray(m.tools) || m.tools.length ||
					!Array.isArray(m.mcp_servers) || m.mcp_servers.length) return unconfirmed();
				phase = 'effect';
				return;
			}
			if (m.type === 'system' && m.subtype === 'compact_boundary') {
				const meta = m.compact_metadata;
				if (boundary || !nativeId(m.uuid) || m.uuid === inputId || meta?.trigger !== 'manual' || !tokens(meta.pre_tokens) ||
					(meta.post_tokens !== undefined && !tokens(meta.post_tokens))) return unconfirmed();
				boundary = { controlId: m.uuid, preTokens: meta.pre_tokens,
					...(meta.post_tokens === undefined ? {} : { postTokens: meta.post_tokens }) };
				return;
			}
			if (m.type === 'user' && boundary && nativeId(m.uuid) && m.uuid !== inputId && m.uuid !== boundary.controlId &&
				m.parent_tool_use_id === null && m.message?.role === 'user') {
				const content = m.message.content;
				if (!nativeSummary && m.isSynthetic === true && m.isReplay === false) {
					const text = summaryText(content);
					const header = 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.';
					if (text?.startsWith(header) && text.slice(header.length).trim()) {
						nativeSummary = { summaryId: m.uuid, summaryHash: createHash('sha256').update(text).digest('hex') };
						return;
					}
				}
				// Stock 2.1.195 may echo the local display; it cannot supply effect evidence.
				const timestamp = typeof m.timestamp === 'string' && m.timestamp.length === 24 ? Date.parse(m.timestamp) : NaN;
				if (nativeSummary && !displaySeen && m.uuid !== nativeSummary.summaryId && m.isReplay === true &&
					Object.keys(m).length === 7 && Object.keys(m.message).length === 2 &&
					Number.isFinite(timestamp) && new Date(timestamp).toISOString() === m.timestamp &&
					typeof content === 'string' && content.startsWith('<local-command-stdout>Compacted ') && content.endsWith('</local-command-stdout>')) {
					displaySeen = true;
					return;
				}
			}
			if (m.type === 'result' && m.subtype === 'success' && m.is_error === false && boundary && nativeSummary) {
				io.complete({ ...boundary, ...nativeSummary });
				return;
			}
			unconfirmed();
		},
	});
}
