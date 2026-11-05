import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
import { OpencodeDriver } from './opencode-driver.js';
import type { OpencodeServerManager } from './server-manager.js';

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'oc-capabilities-')); roots.push(root);
	const workspace = join(root, 'new-workspace');
	const client = {
		global: { health: vi.fn(async () => ({ data: { healthy: true, version: '1.17.9' } })) },
		provider: { list: vi.fn(async () => ({ data: { all: [{ id: 'vendor', name: 'Vendor', env: ['SECRET'], models: { small: { id: 'small', name: 'Small' } } }], connected: ['vendor'], default: { vendor: 'small' } } })) },
		app: { skills: vi.fn(async () => ({ data: [{ name: 'review', description: 'Review code', location: '/private/skill', content: 'secret instructions' }] })) },
		command: { list: vi.fn(async () => ({ data: [{ name: 'audit', description: 'Audit project', hints: ['$1', '$ARGUMENTS'], template: 'private prompt' }] })) },
	};
	const server = { url: 'http://native-one:4096', ensureStarted: vi.fn(async () => {}), getDiscoveryClient: () => client };
	return { client, workspace, server, driver: new OpencodeDriver({ server: server as unknown as OpencodeServerManager }) };
}

describe('OpenCode native capability boundary', () => {
	it('prepares a new trusted workspace before discovery and binds catalogs to the native instance', async () => {
		const { driver, workspace, server, client } = fixture();
		expect(existsSync(workspace)).toBe(false);
		client.app.skills.mockImplementation(async () => { expect(existsSync(workspace)).toBe(true); return { data: [] }; });
		const input = { workspace, signal: new AbortController().signal };
		const first = await driver.discoverCapabilities(input);
		server.url = 'http://native-two:4096';
		const second = await driver.discoverCapabilities(input);
		expect(first.version).not.toBe(second.version);
		expect(JSON.stringify(second)).not.toContain(server.url);
		expect(JSON.stringify(second)).not.toContain(workspace);
		expect(second.capabilities[0].description).toBeTruthy();
	});
	it('shows connected models first in an honestly bounded plain-text preview', async () => {
		const { driver, workspace, client } = fixture();
		const models = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`m${index}`, { id: `m${index}`, name: `Long model name ${index}` }]));
		client.provider.list.mockResolvedValue({ data: { all: [
			{ id: 'aaa', name: 'Offline', env: [], models },
			{ id: 'zzz', name: 'Connected', env: [], models: { special: { id: 'special', name: 'Special' } } },
		], connected: ['zzz'], default: {} } });
		const input = { workspace, signal: new AbortController().signal };
		const catalog = await driver.discoverCapabilities(input);
		const result = await driver.executeCapability({ ...input, capabilityId: 'model.list', catalogVersion: catalog.version });
		expect(result.text!.split('\n')[1]).toBe('zzz/special — Special (connected)');
		expect(result.text).toMatch(/Showing \d+ of 201 models \(1 connected\)/);
		expect(result.text!.length).toBeLessThan(2000);
		expect(result.text).not.toContain('structured result');
	});
	it('lists sanitized native models only for a current catalog; rejects disconnected commands', async () => {
		const { driver, client, workspace } = fixture();
		const context = { workspace: workspace, signal: new AbortController().signal };
		const catalog = await driver.discoverCapabilities(context);
		client.provider.list.mockClear();
		const result = await driver.executeCapability({ ...context, capabilityId: 'model.list', catalogVersion: catalog.version });
		expect(client.provider.list).toHaveBeenCalledOnce();
		expect(result).toEqual({ status: 'completed', text: 'Available models:\nvendor/small — Small (connected)', nativeResult: { models: [{ id: 'vendor/small', providerId: 'vendor', modelId: 'small', name: 'Small', connected: true, default: true }] } });
		expect(JSON.stringify(result)).not.toContain('SECRET');
		expect(client.provider.list).toHaveBeenCalledWith({ directory: workspace }, expect.objectContaining({ throwOnError: true }));
		expect(await driver.executeCapability({ ...context, capabilityId: 'skill:review', catalogVersion: catalog.version })).toMatchObject({ status: 'unsupported' });
		expect(await driver.executeCapability({ ...context, capabilityId: 'model.list', catalogVersion: 'stale' })).toMatchObject({ status: 'failed', error: 'catalog_stale' });
		expect(await driver.executeCapability({ ...context, capabilityId: 'model.list', catalogVersion: catalog.version, parameters: { model: 'other' } })).toMatchObject({ status: 'failed', error: 'invalid_parameters' });
	});
	it('fails native discovery instead of inventing support and invalidates runtime version changes', async () => {
		const { driver, client, workspace } = fixture();
		const context = { workspace: workspace, signal: new AbortController().signal };
		const before = await driver.discoverCapabilities(context);
		client.global.health.mockResolvedValue({ data: { healthy: true, version: '1.18.0' } });
		const after = await driver.discoverCapabilities(context);
		expect(after.version).not.toBe(before.version);
		client.app.skills.mockRejectedValue(new Error('endpoint unavailable'));
		await expect(driver.discoverCapabilities(context)).rejects.toThrow('endpoint unavailable');
	});
	it('discovers real per-workspace metadata without exposing prompts or enabling commands', async () => {
		const { driver, client, workspace } = fixture();
		const catalog = await driver.discoverCapabilities({ workspace: workspace, signal: new AbortController().signal });
		expect(catalog.framework).toBe('opencode');
		expect(catalog.runtimeVersion).toBe('1.17.9');
		expect(catalog.capabilities).toEqual([
			expect.objectContaining({ id: 'model.list', supported: true, executable: true, defaultVisibility: 'public', parameters: [] }),
			expect.objectContaining({ id: 'skill:review', supported: true, executable: false, defaultVisibility: 'public' }),
			expect.objectContaining({ id: 'command:audit', supported: true, executable: false, defaultVisibility: 'hidden',
				description: 'Audit project Native argument hints only; requiredness unavailable; execution not connected.',
				parameters: [{ name: '$1', type: 'string', required: false }, { name: '$ARGUMENTS', type: 'string', required: false }] }),
		]);
		expect(JSON.stringify(catalog)).not.toMatch(/private|secret instructions|\/workspace/);
		expect(client.app.skills).toHaveBeenCalledWith({ directory: workspace }, expect.objectContaining({ throwOnError: true }));
		const other = await driver.discoverCapabilities({ workspace: join(workspace, 'other'), signal: new AbortController().signal });
		expect(other.version).not.toBe(catalog.version);
	});
});
