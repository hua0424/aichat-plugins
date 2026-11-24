import { randomUUID } from 'node:crypto';
import { runCcControlChild } from './control-child.js';
import type { CcKillFn, CcSpawnFn } from './headless-driver.js';

const DEADLINE_MS = 22_000;
const inventoryString = (value: unknown): value is string => typeof value === 'string' &&
	value.length <= 256 && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value);

type NativeModel = { value: string; displayName: string };

/** One disposable native inventory request, not a chat run. Safe mode still permits admin managed policy. */
export async function readCcModelInventory({ cwd, signal, claudeBin, spawn, kill,
	platform }: { cwd: string; signal: AbortSignal; claudeBin?: string; spawn?: CcSpawnFn;
	kill?: CcKillFn; platform?: NodeJS.Platform }): Promise<NativeModel[]> {
	const requestId = randomUUID();
	const argv = ['-p', '--safe-mode', '--no-session-persistence', '--input-format', 'stream-json',
		'--output-format', 'stream-json', '--verbose', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
	const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_NON_INTERACTIVE: '1', MAX_RETRIES: '0' };
	for (const key of Object.keys(env)) {
		if (/^(?:AICHAT_.*|OPENCLAW_BIND|OPENCODE_SESSION_ID|CODEX_THREAD_ID)$/i.test(key)) delete env[key];
	}
	return runCcControlChild<NativeModel[]>({ label: 'model inventory', cwd, signal, claudeBin, spawn, kill, platform,
		argv, env, deadlineMs: DEADLINE_MS,
		initialize: (io) => io.write({ type: 'control_request', request_id: requestId, request: { subtype: 'initialize' } }),
		onLine(line, io) {
			const frame = JSON.parse(line);
			const response = frame?.response;
			if (frame?.type !== 'control_response' || response?.subtype !== 'success' || response.request_id !== requestId) {
				return io.fail('received an unexpected frame');
			}
			const rows = response.response?.models;
			if (!Array.isArray(rows) || rows.length < 1 || rows.length > 256) return io.fail('returned invalid models');
			const projection: NativeModel[] = [];
			for (const row of rows) {
				if (!inventoryString(row?.value) || !inventoryString(row?.displayName)) return io.fail('returned invalid models');
				projection.push({ value: row.value, displayName: row.displayName });
			}
			io.complete(projection);
		},
	});
}
