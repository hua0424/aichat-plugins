import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AICHAT_RUN_BIND, handleBeforeToolCall } from './run-exec-bridge.js';

const token = 'f'.repeat(64);
function tmpDir() {
	const dir = mkdtempSync(join(tmpdir(), 'claw-bridge-'));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function write(dir: string, runId: string, coreRun: string, tok = token) {
	writeFileSync(join(dir, `${runId}.json`),
		JSON.stringify({ token: tok, runId: coreRun, conversationId: 'c', generation: 1, createdAt: 1 }));
}

describe('before_tool_call exec bridge (#406)', () => {
	it('non-exec tools are left untouched', async () => {
		const t = tmpDir();
		try {
			expect(await handleBeforeToolCall({ event: { toolName: 'read', params: {} }, ctx: {} }, { dir: t.dir }))
				.toBeUndefined();
		} finally { t.cleanup(); }
	});

	it('exec with the exact run file gets the frozen token verbatim', async () => {
		const t = tmpDir();
		try {
			write(t.dir, 'gw-A', 'core-A');
			const result = await handleBeforeToolCall(
				{ event: { toolName: 'exec', params: { command: 'aichat send-message', env: { PATH: 'x' } }, runId: 'gw-A', toolCallId: 'tc1' },
					ctx: { toolName: 'exec', runId: 'gw-A', toolCallId: 'tc1' } },
				{ dir: t.dir, timeoutMs: 50, intervalMs: 5 });
			expect(result?.params.env).toMatchObject({ PATH: 'x', [AICHAT_RUN_BIND]: token });
		} finally { t.cleanup(); }
	});

	it('exec overwrites a model-forged reserved value with the exact token', async () => {
		const t = tmpDir();
		try {
			write(t.dir, 'gw-A', 'core-A');
			const result = await handleBeforeToolCall(
				{ event: { toolName: 'exec', params: { env: { [AICHAT_RUN_BIND]: 'forged' } }, runId: 'gw-A' }, ctx: {} },
				{ dir: t.dir, timeoutMs: 50, intervalMs: 5 });
			expect((result?.params.env as Record<string, string>)[AICHAT_RUN_BIND]).toBe(token);
		} finally { t.cleanup(); }
	});

	it('exec with no exact file clears the key (never another run’s token, never a guess)', async () => {
		const t = tmpDir();
		try {
			write(t.dir, 'gw-A', 'core-A');
			const result = await handleBeforeToolCall(
				{ event: { toolName: 'exec', params: { env: { [AICHAT_RUN_BIND]: 'inherited' } }, runId: 'gw-B' }, ctx: {} },
				{ dir: t.dir, timeoutMs: 60, intervalMs: 5 });
			expect((result?.params.env as Record<string, string>)[AICHAT_RUN_BIND]).toBe('');
		} finally { t.cleanup(); }
	});

	it('exec without any trusted runId still strips the reserved key (legacy/TUI safe)', async () => {
		const t = tmpDir();
		try {
			const result = await handleBeforeToolCall(
				{ event: { toolName: 'exec', params: { env: { [AICHAT_RUN_BIND]: 'forged' } } }, ctx: {} },
				{ dir: t.dir });
			expect((result?.params.env as Record<string, string>)[AICHAT_RUN_BIND]).toBe('');
		} finally { t.cleanup(); }
	});

	it('ctx runId is accepted when the event omits it (shape tolerance)', async () => {
		const t = tmpDir();
		try {
			write(t.dir, 'gw-C', 'core-C');
			const result = await handleBeforeToolCall(
				{ event: { toolName: 'EXEC', params: {} }, ctx: { runId: 'gw-C' } },
				{ dir: t.dir, timeoutMs: 50, intervalMs: 5 });
			expect((result?.params.env as Record<string, string>)[AICHAT_RUN_BIND]).toBe(token);
		} finally { t.cleanup(); }
	});

	it('never throws on odd input', async () => {
		const t = tmpDir();
		try {
			expect(await handleBeforeToolCall(undefined as unknown as { event: null }, { dir: t.dir })).toBeUndefined();
			expect(await handleBeforeToolCall({ event: null }, { dir: t.dir })).toBeUndefined();
		} finally { t.cleanup(); }
	});
});
