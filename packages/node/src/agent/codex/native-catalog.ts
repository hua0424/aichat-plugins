import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { AgentCapability, AgentCapabilityCatalog } from '../events.js';
import type { CodexAppServer } from './app-server.js';

type Models = NonNullable<AgentCapabilityCatalog['models']>['items'];
const object = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);

/** Codex-only discovery: native inventory is complete before the public menu is paged. */
export async function codexCatalog(channel: CodexAppServer, workspace: string, signal: AbortSignal) {
	await mkdir(workspace, { recursive: true });
	const cwd = await realpath(workspace);
	signal.throwIfAborted();
	const config = object(object(await channel.request('config/read', { cwd, includeLayers: false }))?.config);
	const provider = id(config?.model_provider) ? config.model_provider : undefined;
	const skills = object(await channel.request('skills/list', { cwds: [cwd], forceReload: true }));
	if (!Array.isArray(skills?.data) || skills.data.length !== 1) throw new Error('CODEX_NATIVE_DISCOVERY_UNVERIFIED');
	const entry = object(skills.data[0]);
	if (entry?.cwd !== cwd || !Array.isArray(entry.skills) || !Array.isArray(entry.errors)) throw new Error('CODEX_NATIVE_DISCOVERY_UNVERIFIED');
	if (entry.errors.length) throw new Error('CODEX_NATIVE_SKILLS_ERRORS');
	const inventory = entry.skills.map((raw: unknown) => {
		const skill = object(raw);
		if (!skill || !id(skill.name) || !id(skill.scope) || typeof skill.path !== 'string' || !isAbsolute(skill.path) ||
			skill.path.includes('\0') || typeof skill.enabled !== 'boolean' || typeof skill.description !== 'string')
			throw new Error('CODEX_NATIVE_DISCOVERY_UNVERIFIED');
		return { name: skill.name, scope: skill.scope, path: skill.path, enabled: skill.enabled, description: skill.description };
	}).sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope) || a.path.localeCompare(b.path));
	const models: Models = [], nativeModels: Array<{ id: string; model: string; label: string; hidden: boolean }> = [];
	const seen = new Set<string>(), cursors = new Set<string>();
	let cursor: string | undefined;
	do {
		signal.throwIfAborted();
		const page = object(await channel.request('model/list', { limit: 100, includeHidden: true, ...(cursor ? { cursor } : {}) }));
		if (!Array.isArray(page?.data) || (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || !page.nextCursor.length)))
			throw new Error('CODEX_NATIVE_DISCOVERY_UNVERIFIED');
		for (const raw of page.data) {
			const model = object(raw);
			if (!model || !id(model.id) || !id(model.model) || !id(model.displayName) || typeof model.hidden !== 'boolean' || seen.has(model.model))
				throw new Error('CODEX_NATIVE_DISCOVERY_UNVERIFIED');
			seen.add(model.model);
			nativeModels.push({ id: model.id, model: model.model, label: model.displayName, hidden: model.hidden });
			// Native discovery has no connection-status field; configuration is not reachability proof.
			if (provider) models.push({ providerId: provider, modelId: model.model, label: model.displayName, connected: false });
		}
		cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
		if (cursor && cursors.has(cursor)) throw new Error('CODEX_NATIVE_DISCOVERY_CURSOR_REPEATED');
		if (cursor) cursors.add(cursor);
	} while (cursor);
	signal.throwIfAborted();
	nativeModels.sort((a, b) => a.model.localeCompare(b.model));
	models.sort((a, b) => a.modelId.localeCompare(b.modelId));
	const names = new Set<string>(), counts = new Map<string, number>();
	for (const skill of inventory) counts.set(skill.name, (counts.get(skill.name) ?? 0) + 1);
	const capabilities: AgentCapability[] = [
		{ id: 'model.list', kind: 'model', name: 'Models', supported: !!provider, executable: !!provider,
			...(!provider ? { reason: 'native_provider_unverified' } : {}), defaultVisibility: 'public', scope: 'workspace', parameters: [], source: 'model' },
		{ id: 'model.set', kind: 'model', name: 'Select model', supported: !!provider, executable: !!provider,
			...(!provider ? { reason: 'native_provider_unverified' } : {}), defaultVisibility: 'public', scope: 'conversation', source: 'model',
			parameters: [{ name: 'providerId', type: 'string', required: true }, { name: 'modelId', type: 'string', required: true }] },
		{ id: 'session.reset', kind: 'command', name: 'New Codex thread', supported: true, executable: true,
			defaultVisibility: 'public', scope: 'conversation', parameters: [], source: 'session' },
		{ id: 'session.compact', kind: 'command', name: 'Compact Codex context', supported: false, executable: false,
			reason: 'native_request_and_summary_attribution_unproven', defaultVisibility: 'public', scope: 'conversation', parameters: [], source: 'session' },
	];
	for (const skill of inventory) {
		if (names.has(skill.name)) continue;
		names.add(skill.name);
		const ambiguous = counts.get(skill.name)! > 1;
		capabilities.push({ id: `skill:${skill.name}`, kind: 'skill', name: skill.name, description: skill.description,
			supported: skill.enabled && !ambiguous, executable: false,
			reason: ambiguous ? 'native_skill_namespace_ambiguous' : !skill.enabled ? 'native_skill_disabled' : 'execution_not_connected',
			defaultVisibility: 'public', scope: 'workspace', source: 'skill', parameters: [{ name: 'arguments', type: 'string', required: false }] });
	}
	const catalog: AgentCapabilityCatalog = { framework: 'codex', runtimeVersion: '0.142.3', capabilities,
		version: createHash('sha256').update(JSON.stringify(['codex-native-catalog-v1', '0.142.3', cwd, provider ?? null, inventory, nativeModels])).digest('hex') };
	return { catalog, models, provider };
}
