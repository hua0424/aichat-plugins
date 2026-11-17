import { afterEach, describe, expect, it, vi } from 'vitest';
import { platform, tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { PreparedRun } from '../agent/events.js';
import { createCodexDriver, selectStartAgents } from './start.js';
import { CodexDriver } from '../agent/codex/codex-driver.js';
import { CodexNativeDriver } from '../agent/codex/native-driver.js';
import { loadAgentRegistry } from '../registry.js';

const sdk = vi.hoisted(() => ({ client: vi.fn(), startThread: vi.fn() }));
vi.mock('@openai/codex-sdk', () => ({ Codex: sdk.client }));

vi.mock('node:os', async (original) => ({
	...await original<typeof import('node:os')>(),
	platform: vi.fn(),
}));
afterEach(() => { vi.resetAllMocks(); });

describe('start registry preflight', () => {
	it.each(['linux', 'darwin', 'win32'] as const)('filters only unsupported native startup identities on %s', (host) => {
		vi.mocked(platform).mockReturnValue(host);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const entries = loadAgentRegistry({ agents: [
				{ tool: 'codex', token: 'secret-native', model: 'private-model', codexNative: true },
				{ tool: 'codex', token: 'sdk-default' },
				{ tool: 'codex', token: 'sdk-explicit', codexNative: false },
				{ tool: 'cc', token: 'cc' },
			] });
			expect(entries).toHaveLength(4);
			expect(selectStartAgents(entries)).toEqual(host === 'win32' ? entries.slice(1) : entries);
			expect(warn.mock.calls).toEqual(host === 'win32' ? [[
				'[start] skipping agent entry #0: codexNative: true is not supported on Windows; use the SDK adapter (omit codexNative or set it to false)',
			]] : []);
			expect(entries[0].codexNative).toBe(true);
		} finally { warn.mockRestore(); }
	});
});

describe('start Codex driver factory', () => {
	it.each([undefined, false])('preserves SDK model, base/run env and developer instructions with opt-in=%s', async (codexNative) => {
		vi.mocked(platform).mockReturnValue('linux');
		sdk.client.mockImplementation(() => ({ startThread: sdk.startThread }));
		sdk.startThread.mockReturnValue({ runStreamed: async () => ({ events: (async function* () {
			yield { type: 'turn.failed', error: { message: 'offline fixture terminal' } };
		})() }) });
		const workspace = mkdtempSync(join(tmpdir(), 'codex-factory-'));
		const env = { PATH: '/fixture/bin', AICHAT_RUN_BIND: 'stale-binding' };
		const entry = loadAgentRegistry({ agents: [{ tool: 'codex', token: 'sdk', model: 'chosen-model', codexNative }] })[0];
		const driver = createCodexDriver(entry, env);
		const input: PreparedRun = {
			runId: 'fixture-run', message: 'user text', systemPrompt: 'frozen persona', workspace, replyToken: 'frozen-binding',
			signal: new AbortController().signal, capabilities: { async invoke() {} }, async saveRecovery() {},
			conversation: { id: 'fixture-conversation', generation: 1, nativeState: undefined,
				assertCurrent() {}, async saveNativeState() {}, async registerNativeAlias() {} },
		};
		try {
			const events = [];
			for await (const event of driver.createRun(input).events) events.push(event);
			expect(events).toEqual([{ type: 'error', message: 'offline fixture terminal' }]);
			expect(sdk.client).toHaveBeenCalledWith({ env: { PATH: '/fixture/bin', AICHAT_RUN_BIND: 'frozen-binding' },
				config: { developer_instructions: 'frozen persona' } });
			expect(sdk.startThread).toHaveBeenCalledWith(expect.objectContaining({ model: 'chosen-model', workingDirectory: workspace }));
			expect(env).toEqual({ PATH: '/fixture/bin', AICHAT_RUN_BIND: 'stale-binding' });
		} finally {
			await driver.disconnect();
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	it.each(['linux', 'darwin'] as const)('selects native controls only for opted-in agents on %s', (host) => {
		vi.mocked(platform).mockReturnValue(host);
		const entries = loadAgentRegistry({ agents: [
			{ tool: 'codex', token: 'native', codexNative: true, model: 'native-model' },
			{ tool: 'codex', token: 'default' },
			{ tool: 'codex', token: 'explicit', codexNative: false },
		] });
		const drivers = entries.map((entry) => createCodexDriver(entry, {}));
		expect(drivers[0]).toBeInstanceOf(CodexNativeDriver);
		expect(drivers[0].type).toBe('codex');
		expect(drivers[0].features).toEqual({ cancel: 'best-effort', reset: 'supported', promptUpdate: 'new-session' });
		expect(drivers[0]).toMatchObject({ discoverCapabilities: expect.any(Function), executeCapability: expect.any(Function), createNativeInput: expect.any(Function) });
		expect(drivers[1]).toBeInstanceOf(CodexDriver);
		expect(drivers[2]).toBeInstanceOf(CodexDriver);
	});

	it('rejects an explicit Windows native request instead of falling back to SDK', () => {
		vi.mocked(platform).mockReturnValue('win32');
		expect(() => createCodexDriver({ tool: 'codex', token: 'secret', codexNative: true }, {}))
			.toThrow('codexNative: true is not supported on Windows; use the SDK adapter (omit codexNative or set it to false)');
	});

	it.each(['linux', 'win32'] as const)('keeps absent/false opt-in on the SDK for %s', (host) => {
		vi.mocked(platform).mockReturnValue(host);
		const entries = loadAgentRegistry({ agents: [
			{ tool: 'codex', token: 'default', model: 'sdk-default-model' },
			{ tool: 'codex', token: 'explicit', codexNative: false, model: 'sdk-explicit-model' },
		] });
		for (const entry of entries) {
			const driver = createCodexDriver(entry, {});
			expect(driver).toBeInstanceOf(CodexDriver);
			expect(driver.type).toBe('codex');
			expect(driver.features).toEqual({ cancel: 'best-effort', reset: 'supported', promptUpdate: 'new-session' });
			expect('discoverCapabilities' in driver).toBe(false);
		}
	});
});
