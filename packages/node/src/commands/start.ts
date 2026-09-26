import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, getServerUrl, detectClawConfig, AICHAT_HOME, type AichatConfig } from '../config.js';
import { HulaWSClient } from '../server/hula-ws.js';
import { MessageHandler } from '../handler/message.js';
import { OpenclawDriver } from '../agent/openclaw/openclaw-driver.js';
import { OpencodeDriver } from '../agent/opencode/opencode-driver.js';
import { OpencodeServerManager, defaultServerManagerDeps } from '../agent/opencode/server-manager.js';
import { CodexDriver } from '../agent/codex/codex-driver.js';
import { Codex } from '@openai/codex-sdk';
import { CcHeadlessDriver } from '../agent/cc/headless-driver.js';
import { CcBroker, ccBrokerPort } from '../agent/cc/broker.js';
import { CcSessionRegistry, buildCcBridgeSink } from '../agent/cc/sink.js';
import { FileCcTranscriptWriter } from '../agent/cc/transcript.js';
import { HulaApiClient, restBaseUrlFromWsUrl } from '../api/hula-api.js';
import { loadAgentRegistry, resolveAgentCredential, type AgentEntry } from '../registry.js';
import { Supervisor } from '../supervisor.js';
import { getMachineCode } from '../auth/machine.js';
import {
	CapabilityRegistry,
	sendMessageCapability,
	memberInfoCapability,
	listFriendsCapability,
	findFriendCapability,
	listGroupsCapability,
	listGroupMembersCapability,
	resetSessionCapability,
} from '../capability/registry.js';
import { CapabilityEndpoint, capabilitySocketPath } from '../capability/endpoint.js';
import { ConversationStore, type Provider } from '../capability/conversations.js';
import { legacyBridges } from '../capability/legacy-bridges.js';
import type { ContextCandidate } from '../capability/endpoint.js';
import { installSkill } from '../capability/skill.js';
import { ensureAichatOnPath } from '../util/path-inject.js';

/**
 * aichat start — 读取本地配置自动连接。
 * 单一构建路径：加载 registry；为空则打印带迁移示例的错误并非零退出，否则走多身份监督器路径。
 * （单身份只是长度为 1 的 registry —— 旧的单身份回退分支已在 aichatoverview#163 删除。）
 */
export async function start(): Promise<void> {
	// aichatoverview#257 — 手册方案 A（`node packages/node/dist/cli.js start`，不 npm link）启动时
	// `aichat` 不在 agent 的 PATH 上，skill 的裸命令 `aichat send-message` 无法解析、回复链路断。
	// 把自身 CLI 的 launcher 目录注入 PATH（start 一次，spawn 的 serve/codex/cc 子进程全部继承）。
	const pathBin = ensureAichatOnPath();
	if (pathBin) console.log(`[start] PATH += ${pathBin} (aichat launcher)`);

	const config = loadConfig();
	const registry = loadAgentRegistry(config);

	if (registry.length === 0) {
		console.error(
			'[start] No agents configured. Add an "agents" array to ~/.aichat/config.jsonc, e.g. { "agents": [{ "tool": "openclaw", "token": "<激活 token>" }] } — single-identity is just a one-element registry.',
		);
		process.exit(1);
	}

	await startMultiIdentity(config, registry);
}

/**
 * REQ-008 #76 多身份路径：用真实 deps 构建 Supervisor 并拉起 N 条身份链路（per-agent 隔离）。
 */
async function startMultiIdentity(config: AichatConfig, registry: AgentEntry[]): Promise<void> {
	const serverUrl = getServerUrl(config);
	const clawConfig = detectClawConfig(config);
	// 与 activate.ts 同源：ws://host:port/api/ws/ws → http://host:port/api
	const httpBase = serverUrl
		.replace('ws://', 'http://')
		.replace('wss://', 'https://')
		.replace(/\/ws\/ws$/, '');
	const restBaseUrl = restBaseUrlFromWsUrl(serverUrl);

	console.log(`[start] Multi-identity mode: ${registry.length} agent(s)`);
	console.log(`[start] Server: ${serverUrl}`);
	console.log(`[start] Claw Gateway: ${clawConfig.gatewayUrl}`);

	// REQ-008 #77: 单例 opencode server manager——「1 个 server 服务 N 个身份」。
	// 在此构建一次并被所有 opencode 身份的 buildDriver 闭包共享；仅当注册表里真有
	// opencode 身份、且该身份 connect() 时才惰性 ensureStarted（lazy）。
	// REQ-010 S1: opencode does NOT inject OPENCODE_SESSION_ID into the bash tool subprocess, so the
	// agent's `aichat send-message` had no session to resolve its bound (aiclaw, room). Load the
	// session-env plugin into the spawned server: its `shell.env` hook injects OPENCODE_SESSION_ID
	// into every shell exec. Point at the BUILT plugin (dist/.../session-env-plugin.js), exactly like
	// the retired hula-plugin shim was wired. This is binding plumbing, NOT a tool/capability.
	const sessionEnvPluginPath = fileURLToPath(new URL('../agent/opencode/session-env-plugin.js', import.meta.url));
	const opencodeServer = new OpencodeServerManager(defaultServerManagerDeps(), { pluginPaths: [sessionEnvPluginPath] });
	const opencodeWorkspaceBase = join(AICHAT_HOME, 'opencode', 'workspace');

	// REQ-010 S5: codex needs NO shared server (the SDK spawns `codex exec` per turn) and NO
	// env-injection plugin (codex natively injects CODEX_THREAD_ID into its exec shell). Its
	// per-conversation workspaces live under ~/.aichat/codex/workspace, mirroring opencode's layout.
	const codexWorkspaceBase = join(AICHAT_HOME, 'codex', 'workspace');
	// SDK v0.142.3 accepts a per-client env (without inheriting process.env); never mutate global env.
	const codexEnv = Object.fromEntries(Object.entries(process.env).filter(([name, value]) =>
		value !== undefined && !['OPENCODE_SESSION_ID', 'OPENCLAW_BIND', 'AICHAT_BIND', 'AICHAT_CONTEXT_KEY'].includes(name))) as Record<string, string>;

	// REQ-011 S2 / #293: one shared identity+room+spawn bridge routes CC tool hooks into only
	// their matching headless turn. Every CC identity's driver and the broker share this registry.
	// The session store persists (uid,room)→session_id for cross-turn/restart --resume.
	const ccRegistry = new CcSessionRegistry();
	const ccWorkspaceBase = join(AICHAT_HOME, 'cc', 'workspace');
	// REQ-011 S3 (AC5/AC9): one shared per-room transcript writer (inbound + teed CC output), so the owner
	// can read a headless CC turn's full session offline (~/.aichat/cc/transcripts/<binding>.jsonl).
	const ccTranscript = new FileCcTranscriptWriter();

	// Drivers keep their native CLI APIs; these thin views all delegate to ONE atomic core record.
	// Construction is deferred until credentials are verified and the endpoint's single-writer lock is held.
	let conversations: ConversationStore | undefined;
	const bridges = legacyBridges(() => {
		if (!conversations) throw new Error('conversation bindings not ready');
		return conversations;
	});
	const bindTokenStore = bridges.bindTokens;

	const supervisor = new Supervisor({
		resolveCredential: (entry) =>
			resolveAgentCredential(entry, { machineCode: getMachineCode(), httpBase }),
		buildDriver: (entry) => {
			if (entry.tool === 'openclaw') {
				return new OpenclawDriver(clawConfig.gatewayUrl, clawConfig.token, bindTokenStore);
			}
			if (entry.tool === 'opencode') {
				return new OpencodeDriver({
					server: opencodeServer, // 单例：所有 opencode 身份共享同一 server
					workspaceBase: opencodeWorkspaceBase,
					sessionStore: bridges.opencode,
					...(entry.model !== undefined ? { model: entry.model } : {}),
				});
			}
			if (entry.tool === 'codex') {
				// No shared-server singleton (unlike opencode): the codex SDK spawns `codex exec` per
				// turn. `new Codex()` omits apiKey/baseUrl → uses the baked ~/.codex/config.toml provider
				// + auth.json. resolveSession reverse-looks-up the bound (aiclaw, room) by CODEX_THREAD_ID.
				return new CodexDriver({
					codex: new Codex({ env: codexEnv }),
					workspaceBase: codexWorkspaceBase,
					sessionStore: bridges.codex,
					...(entry.model !== undefined ? { model: entry.model } : {}),
				});
			}
			if (entry.tool === 'cc') {
				// REQ-011 S2: claude-code is NODE-DRIVEN headless. CcHeadlessDriver spawns `claude -p`
				// (stream-json) per inbound turn on the standard supervised path. The reply
				// still goes out-of-band via `aichat send-message`; thinking is teed from stdout,
				// while tool hooks reach the matching turn through the shared registry.
				// session_id is persisted for cross-turn/restart --resume.
				return new CcHeadlessDriver({
					workspaceBase: ccWorkspaceBase,
					brokerPort: ccBrokerPort(),
					sessionStore: bridges.cc,
					bindTokens: bindTokenStore,
					registry: ccRegistry,
					transcript: ccTranscript,
				});
			}
			// 未知 tool 抛错使该身份降级，不影响其它身份。
			throw new Error('unsupported agent tool: ' + entry.tool);
		},
		buildApiClient: (cred) => new HulaApiClient(restBaseUrl, cred.connectionToken),
		// #193: 上报主机信息时的 workspace 根按 tool 取舍——opencode/codex/cc 各有 workspace base，
		// openclaw 无 workspace 概念 → undefined（payload 省略 workspaceBase 字段）。
		workspaceBaseFor: (entry) =>
			entry.tool === 'opencode'
				? opencodeWorkspaceBase
				: entry.tool === 'codex'
					? codexWorkspaceBase
					: entry.tool === 'cc'
						? ccWorkspaceBase
						: undefined,
		buildWs: (cred, hooks) =>
			new HulaWSClient({
				url: serverUrl,
				token: cred.connectionToken,
				clientId: cred.machineCode,
				uid: cred.uid,
				onMessage: hooks.onMessage,
				onConnected: hooks.onConnected,
				onDisconnected: hooks.onDisconnected,
				onAuthError: hooks.onAuthError,
			}),
		buildHandler: (ws, driver, uid, api, onTokenExpired) =>
			new MessageHandler(ws, driver, uid, api, undefined, onTokenExpired),
	});

	// Hold the endpoint's exclusive home lease before any driver can mutate a binding or accept inbound WS.
	// Core lookup, not the first matching driver, is the only capability routing authority.
	const registry$ = new CapabilityRegistry();
	registry$.register('send-message', sendMessageCapability());
	// REQ-010 S3: read-only query capabilities (token-scoped via the resolved per-identity apiClient)
	registry$.register('member-info', memberInfoCapability());
	registry$.register('list-friends', listFriendsCapability());
	registry$.register('find-friend', findFriendCapability());
	// REQ-010 S4: group query capabilities (list-groups token-scoped; list-group-members server-validated)
	registry$.register('list-groups', listGroupsCapability());
	registry$.register('list-group-members', listGroupMembersCapability());
	// aichatoverview#124: runtime per-room session reset. Identity+room come from the resolved session
	// (ctx), never args; the closure dispatches to the owning agent's driver.resetSession.
	registry$.register(
		'reset-session',
		resetSessionCapability((aiclawUid, roomId) => {
			const owner = supervisor.agents.find((a) => a.uid === aiclawUid);
			if (!owner) return undefined;
			const reset = owner.driver.resetSession?.(aiclawUid, roomId) ?? false;
			return { driverType: owner.driver.type, reset };
		}),
	);
	const bound = (record: ReturnType<ConversationStore['resolveCandidate']>) => {
		if (!record) return undefined;
		const agent = supervisor.agents.find((a) => a.uid === record.identityId && a.status !== 'offline');
		return agent ? { aiclawUid: agent.uid, roomId: record.roomId, apiClient: agent.api,
			conversationId: record.conversationId, generation: record.generation } : undefined;
	};
	const endpoint = new CapabilityEndpoint({
		registry: registry$,
		resolve: (sessionKey) => bound(conversations?.resolveLegacy(sessionKey)),
		resolveCandidate: (candidate: ContextCandidate) => bound(conversations?.resolveCandidate(candidate as
			Parameters<ConversationStore['resolveCandidate']>[0])),
		serverNamespace: restBaseUrl,
		lockHome: AICHAT_HOME,
	});
	let ccBroker: CcBroker | null = null;
	try {
		await endpoint.listen(capabilitySocketPath());
		console.log(`[start] Capability endpoint listening: ${capabilitySocketPath()}`);
		await supervisor.start(registry, false);
		const activeProviders = new Map(supervisor.agents.map((a) => [a.uid, a.driver.type as Provider]));
		if (activeProviders.size !== supervisor.agents.length) throw new Error('duplicate activated identity');
		conversations = new ConversationStore({
			home: AICHAT_HOME, serverNamespace: restBaseUrl,
			activeUids: new Set(activeProviders.keys()), activeProviders,
		});

		// CC hook broker must also be ready before a CC message can reach the driver.
		if (supervisor.agents.some((a) => a.driver.type === 'cc')) {
			ccBroker = new CcBroker({
				resolve: (token) => bindTokenStore.resolve(token),
				sink: buildCcBridgeSink(ccRegistry),
			});
			await ccBroker.listen(ccBrokerPort());
			console.log(`[start] CC broker listening on 127.0.0.1:${ccBrokerPort()}`);
		}
		// Refreshing the skill is best-effort; transport and bindings must never be best-effort.
		try {
			const written = installSkill();
			if (written.length > 0) console.log(`[start] Installed aichat-reply skill: ${written.join(', ')}`);
		} catch {
			/* best-effort */
		}
		supervisor.connectInbound();
	} catch (err) {
		await supervisor.stop().catch(() => {});
		await ccBroker?.close().catch(() => {});
		await opencodeServer.stop().catch(() => {});
		conversations?.close();
		await endpoint.close().catch(() => {});
		throw err;
	}

	let shuttingDown = false;
	const shutdown = async () => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log('\n[start] Shutting down...');
		// Stop per-identity supervision first, THEN close the shared opencode server. The
		// singleton server is owned by global shutdown (not by any OpencodeDriver, whose
		// disconnect() is a no-op for isolation). stop() is a safe no-op if it never started.
		// Quiesce every writer before releasing the home lease held by endpoint.close().
		await supervisor.stop().catch(() => {});
		await ccBroker?.close().catch(() => {});
		await opencodeServer.stop().catch(() => {});
		conversations?.close();
		await endpoint.close().catch(() => {});
		// ConversationStore commits each binding synchronously before exposing it; no queued binding writes.
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
}
