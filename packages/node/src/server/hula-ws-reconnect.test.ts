import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { HulaWSClient } from './hula-ws.js';
import { Supervisor, type SupervisorDeps } from '../supervisor.js';
import type { AgentEntry } from '../registry.js';
import type { AichatCredentials } from '../config.js';
import type { RunDriver } from '../agent/events.js';
import type { HulaApiClient } from '../api/hula-api.js';
import type { MessageHandler } from '../handler/message.js';

/**
 * #459 重连回归（真实 HulaWSClient + loopback WebSocket 服务 + Supervisor 依赖工厂）。
 *
 * 为什么不用 mock ws：本票的缺陷形态全部发生在「真实 socket 生命周期」上——服务端重启后的
 * ECONNREFUSED、upgrade 不结束、非 101 响应 body 永不结束、半开连接、旧连接迟到事件。
 * mock ws 无法证明这些形态下真的会产生新一代连接，只能证明状态机分支。
 *
 * 边界：driver / api / handler 仍是 stub（本票不涉及 agent 运行时）；非生产 E2E（在共享测试环境
 * 上停/起 HuLa 依赖）不在本文件范围，需要单独授权，见 #459 实现评论的未测边界。
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitUntil(pred: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (pred()) return;
		await sleep(10);
	}
	throw new Error(`timeout waiting for ${label} (${timeoutMs}ms)`);
}

type Mode = 'accept' | 'reject401' | 'reject503' | 'stallBody' | 'stallUpgrade';

/**
 * 可控的 loopback HuLa-Server 替身。只实现握手这一层的形态：
 * - accept：正常 101 upgrade，收消息记入 received；
 * - reject401 / reject503：非 101 响应 + 完整 body（permanent / transient 各一）；
 * - stallBody：非 101 响应头 + 半个 body，永不结束（#459 有界读取的复现形态）；
 * - stallUpgrade：接了 TCP 但永不回应 upgrade（握手超时的复现形态）。
 */
class LoopbackHulaServer {
	readonly sockets: WsSocket[] = [];
	readonly rawSockets: Socket[] = [];
	readonly received: string[] = [];
	upgradeRequests = 0;
	port = 0;
	mode: Mode = 'accept';
	private closing = false;
	private readonly server: Server;
	private readonly wss = new WebSocketServer({ noServer: true });

	constructor() {
		this.server = createServer((_req, res) => {
			res.statusCode = 404;
			res.end();
		});
		this.server.on('connection', (s) => {
			// close() 期间到达的迟到连接直接丢掉，否则 server.close() 会等它，测试悬挂。
			if (this.closing) {
				s.destroy();
				return;
			}
			s.on('error', () => {}); // 对端 terminate 后的写入/读取错误是预期形态，不能变成未捕获异常
			this.rawSockets.push(s);
		});
		this.server.on('upgrade', (req, socket, head) => {
			this.upgradeRequests += 1;
			const s = socket as Socket;
			s.on('error', () => {});
			this.rawSockets.push(s);
			switch (this.mode) {
				case 'accept':
					this.wss.handleUpgrade(req, s, head, (ws) => {
						this.sockets.push(ws);
						ws.on('message', (d) => this.received.push(d.toString()));
						ws.on('error', () => {});
					});
					return;
				case 'reject401':
					s.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
					s.end();
					return;
				case 'reject503':
					s.write(
						'HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\n' +
							'Content-Length: 34\r\nConnection: close\r\n\r\n{"success":false,"code":503}',
					);
					s.end();
					return;
				case 'stallBody':
					// 声明 200 字节、只发半个 body 且不 end：真实网关在 body 写一半时挂住的形态。
					s.write(
						'HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\n' +
							'Content-Length: 200\r\n\r\n{"success":false,',
					);
					return;
				case 'stallUpgrade':
					return; // 永不回应 upgrade
			}
		});
	}

	get url(): string {
		return `ws://127.0.0.1:${this.port}`;
	}

	get openSockets(): number {
		return this.sockets.filter((s) => s.readyState === s.OPEN).length;
	}

	async listen(port = 0): Promise<number> {
		await new Promise<void>((resolve) => this.server.listen(port, '127.0.0.1', () => resolve()));
		this.port = (this.server.address() as AddressInfo).port;
		return this.port;
	}

	/** 停服：销毁所有连接并关监听（模拟 HuLa-Server 进程退出）。 */
	async close(): Promise<void> {
		this.closing = true;
		for (const ws of this.sockets.splice(0)) {
			try {
				ws.terminate();
			} catch {
				/* best-effort */
			}
		}
		for (const s of this.rawSockets.splice(0)) {
			try {
				s.destroy();
			} catch {
				/* best-effort */
			}
		}
		await Promise.race([
			new Promise<void>((resolve) => this.server.close(() => resolve())),
			sleep(1000), // 兜底：任何残留连接都不得让测试悬挂
		]);
		this.closing = false;
	}

	/** 在同一端口重新监听（模拟服务恢复）。 */
	async restart(): Promise<void> {
		await this.listen(this.port);
	}

	/** 服务端把某个已建立连接变成「半开」：暂停读，不再回 pong。 */
	pauseSocket(index: number): void {
		const ws = this.sockets[index];
		if (!ws) throw new Error(`no server socket at index ${index}`);
		(ws as unknown as { _socket: Socket })._socket.pause();
	}

	sendFrom(index: number, payload: string): void {
		const ws = this.sockets[index];
		if (!ws) throw new Error(`no server socket at index ${index}`);
		try {
			ws.send(payload);
		} catch {
			/* 旧连接已被对端 terminate 时写入会失败——正是本测试的形态 */
		}
	}

	/** 收尾（afterEach）：连同 wss 一起释放，保证无残留 socket/handle。 */
	async dispose(): Promise<void> {
		await this.close();
		await new Promise<void>((resolve) => this.wss.close(() => resolve()));
	}
}

interface Built {
	sup: Supervisor;
	clients: HulaWSClient[];
	handled: Map<string, unknown[]>;
	destroyed: Map<string, ReturnType<typeof vi.fn>>;
}

/**
 * Supervisor 依赖工厂（与 supervisor.test.ts 同构）：ws 用**真实** HulaWSClient，其余仍 stub。
 * 预算全部注入小值，使一次完整恢复周期在百毫秒级——数值本身不影响生产缺省（见 hula-ws.ts 注释）。
 */
function makeSupervisor(urlFor: (cred: AichatCredentials) => string): Built {
	const clients: HulaWSClient[] = [];
	const handled = new Map<string, unknown[]>();
	const destroyed = new Map<string, ReturnType<typeof vi.fn>>();

	const deps: SupervisorDeps = {
		resolveCredential: async (entry: AgentEntry): Promise<AichatCredentials> => ({
			uid: entry.token.replace('tok-', ''),
			connectionToken: `conn-${entry.token}`,
			machineCode: `mc-${entry.token}`,
			activatedAt: 'now',
		}),
		buildDriver: (): RunDriver =>
			({
				type: 'mock',
				connect: vi.fn().mockResolvedValue(undefined),
				disconnect: vi.fn().mockResolvedValue(undefined),
				features: { cancel: 'best-effort', reset: 'supported', promptUpdate: 'per-run' },
				createRun: vi.fn(),
			}) as unknown as RunDriver,
		buildApiClient: (): HulaApiClient =>
			({
				reportAgentType: vi.fn().mockResolvedValue(undefined),
				reportHostInfo: vi.fn().mockResolvedValue(undefined),
				getAgentPromptTemplates: vi
					.fn()
					.mockResolvedValue({ replyContract: 'rc', identityAnchor: 'ia', personaSection: 'ps' }),
			}) as unknown as HulaApiClient,
		buildWs: (cred, hooks): HulaWSClient => {
			const client = new HulaWSClient({
				url: urlFor(cred),
				token: cred.connectionToken,
				clientId: cred.machineCode,
				uid: cred.uid,
				onMessage: hooks.onMessage,
				onConnected: hooks.onConnected,
				onDisconnected: hooks.onDisconnected,
				onAuthError: hooks.onAuthError,
				// 60ms ping / 600ms 判死：比生产（30s/60s）快两个数量级，但留足 10 个 ping 周期，
				// 全量套件并行时的事件循环抖动不会把健康连接误判成半开（150ms 在满载下会偶发误杀）。
				pingIntervalMs: 60,
				deadAfterMs: 600,
				handshakeTimeoutMs: 250,
				handshakeBodyTimeoutMs: 200,
				reconnectBaseDelayMs: 40,
				maxReconnectDelayMs: 160,
			});
			clients.push(client);
			return client;
		},
		buildHandler: (_ws, _driver, uid: string): MessageHandler => {
			const list: unknown[] = [];
			handled.set(uid, list);
			const destroy = vi.fn();
			destroyed.set(uid, destroy);
			return {
				handle: (m: unknown) => list.push(m),
				onConnected: vi.fn(),
				prewarmGroupConfigs: vi.fn().mockResolvedValue(undefined),
				prewarmPersona: vi.fn().mockResolvedValue(undefined),
				setPromptTemplates: vi.fn(),
				prewarmPromptTemplates: vi.fn().mockResolvedValue(undefined),
				destroy,
			} as unknown as MessageHandler;
		},
	};

	return { sup: new Supervisor(deps), clients, handled, destroyed };
}

const entry = (n: number): AgentEntry => ({ tool: 'openclaw', token: `tok-${n}` });

const msg = (text: string): string =>
	JSON.stringify({ type: 'receiveMessage', data: { msgId: text, content: text } });

describe('#459 recovery with a real HulaWSClient + loopback server', () => {
	let server: LoopbackHulaServer;
	let built: Built | null = null;

	beforeEach(() => {
		// 恢复链路日志很密，测试只断言行为；需要看日志时单独放行 console。
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		server = new LoopbackHulaServer();
		built = null;
	});

	afterEach(async () => {
		await built?.sup.stop();
		await server.dispose();
		vi.restoreAllMocks();
	});

	it(
		'connected → server down (ECONNREFUSED) → server back → NEW connection handles new messages',
		async () => {
			await server.listen();
			built = makeSupervisor(() => server.url);
			await built.sup.start([entry(1)]);
			await waitUntil(() => built!.sup.agents[0]?.status === 'online' && server.sockets.length === 1, 'first connect');
			const client = built.clients[0]!;
			await waitUntil(() => client.isConnected, 'client socket open');

			// 服务端进程退出：连接被销毁，后续重连打到已关闭端口 → ECONNREFUSED
			await server.close();
			await waitUntil(() => built!.sup.agents[0]?.status === 'reconnecting', 'reconnecting');
			await sleep(250); // 让至少一轮 ECONNREFUSED 失败发生
			expect(built.clients.length).toBe(1); // 客户端实例只有一个，重连不新建客户端

			// 服务恢复（同端口）→ 必须是新一代连接
			await server.restart();
			await waitUntil(() => server.sockets.length >= 1, 'recovery connect');
			await waitUntil(() => built!.sup.agents[0]?.status === 'online', 'online after recovery');

			// 新连接可用：新消息走当前连接 → handler 收到
			server.sendFrom(server.sockets.length - 1, msg('after-restart'));
			await waitUntil(() => (built!.handled.get('1')?.length ?? 0) === 1, 'new message handled on the new connection');
			expect(built.handled.get('1')![0]).toMatchObject({ data: { content: 'after-restart' } });
			expect(server.openSockets).toBe(1); // 同一身份不留并行连接
		},
		15000,
	);

	it(
		'transient non-101 (503) → backoff retry → recovery on a later attempt',
		async () => {
			server.mode = 'reject503';
			await server.listen();
			built = makeSupervisor(() => server.url);
			await built.sup.start([entry(1)]);

			// 503 是 transient：不永久断路，持续重试
			await waitUntil(() => server.upgradeRequests >= 3, 'repeated transient attempts');
			expect(built.clients[0]!.closed).toBe(false);
			expect(built.sup.agents[0]!.status).not.toBe('offline');

			server.mode = 'accept';
			await waitUntil(() => built!.sup.agents[0]?.status === 'online', 'online after gateway recovery');
			server.sendFrom(0, msg('post-503'));
			await waitUntil(() => (built!.handled.get('1')?.length ?? 0) === 1, 'message after recovery');
		},
		15000,
	);

	it(
		'half-open connection (no pong) → watchdog terminates → reconnects and serves again',
		async () => {
			await server.listen();
			built = makeSupervisor(() => server.url);
			await built.sup.start([entry(1)]);
			await waitUntil(() => server.sockets.length === 1 && built!.sup.agents[0]?.status === 'online', 'first connect');

			// 半开：TCP 还在，但对端不再处理任何帧（不回 pong）
			server.pauseSocket(0);
			await waitUntil(() => server.sockets.length >= 2, 'reconnect after watchdog terminate', 6000);
			await waitUntil(() => built!.sup.agents[0]?.status === 'online', 'online after half-open recovery');

			server.sendFrom(server.sockets.length - 1, msg('post-half-open'));
			await waitUntil(() => (built!.handled.get('1')?.length ?? 0) === 1, 'message after half-open recovery');
		},
		15000,
	);

	it(
		'upgrade never completes → bounded handshake wait → retry (no infinite hang)',
		async () => {
			server.mode = 'stallUpgrade';
			await server.listen();
			built = makeSupervisor(() => server.url);
			await built.sup.start([entry(1)]);

			// 握手预算 250ms（注入值）：必须看到第二轮 upgrade，而不是永久卡在第一个 socket 上
			await waitUntil(() => server.upgradeRequests >= 2, 'second attempt after handshake timeout', 4000);
			expect(built.clients[0]!.closed).toBe(false);

			server.mode = 'accept';
			await waitUntil(() => built!.sup.agents[0]?.status === 'online', 'online after handshake stall clears');
		},
		15000,
	);

	it(
		'non-101 response body never ends → bounded body wait → retry (no infinite hang)',
		async () => {
			server.mode = 'stallBody';
			await server.listen();
			built = makeSupervisor(() => server.url);
			await built.sup.start([entry(1)]);

			// body 预算 200ms（注入值）：半个 body 永不结束也必须进入 transient 重连
			await waitUntil(() => server.upgradeRequests >= 2, 'second attempt after body timeout', 4000);
			expect(built.clients[0]!.closed).toBe(false);

			server.mode = 'accept';
			await waitUntil(() => built!.sup.agents[0]?.status === 'online', 'online after body stall clears');
		},
		15000,
	);

	it(
		'late handshake classification for a superseded connection must not break the live one',
		async () => {
			server.mode = 'stallBody';
			await server.listen();
			built = makeSupervisor(() => server.url);
			await built.sup.start([entry(1)]);
			await waitUntil(() => server.upgradeRequests === 1, 'first attempt reaches the server');
			const client = built.clients[0]!;
			const firstSocket = server.rawSockets[server.rawSockets.length - 1]!;

			// 在旧 body 还挂着的时候换一代（等价于重连成功）：旧分类结果必须作废
			server.mode = 'accept';
			client.connect();
			await waitUntil(() => server.sockets.length === 1, 'second generation connects');
			// 旧连接迟到的 permanent body（406）——若没有代次守卫，会把新连接永久断路
			firstSocket.write('"code":406,"msg":"token已过期"}');
			firstSocket.end();
			await sleep(350); // 覆盖旧 body 定时器/结束事件窗口

			expect(client.closed).toBe(false);
			expect(client.isConnected).toBe(true);
			expect(built.sup.agents[0]!.status).toBe('online');
			server.sendFrom(0, msg('still-alive'));
			await waitUntil(() => (built!.handled.get('1')?.length ?? 0) === 1, 'live connection still serves');
		},
		15000,
	);

	it(
		'stop() during a pending handshake body → late result cannot revive the stopped instance',
		async () => {
			server.mode = 'stallBody';
			await server.listen();
			const client = new HulaWSClient({
				url: server.url,
				token: 'conn-1',
				clientId: 'mc-1',
				uid: '1',
				onMessage: vi.fn(),
				handshakeTimeoutMs: 500,
				handshakeBodyTimeoutMs: 300,
				reconnectBaseDelayMs: 40,
			});
			client.connect();
			await waitUntil(() => server.upgradeRequests === 1, 'handshake in flight');
			const raw = server.rawSockets[server.rawSockets.length - 1]!;

			client.close();
			// 停止之后迟到的 permanent 结果（晚于 close()）
			raw.write('"code":406,"msg":"token已过期"}');
			raw.end();
			await sleep(500); // 覆盖 body 定时器 + 若误排重连则至少一次重连窗口

			expect(client.closed).toBe(true);
			expect(client.isConnected).toBe(false);
			expect(server.upgradeRequests).toBe(1); // 没有任何重连
		},
		15000,
	);

	it(
		'one identity degraded by a permanent auth error does not affect another identity',
		async () => {
			const authFail = new LoopbackHulaServer();
			authFail.mode = 'reject401';
			await authFail.listen();
			await server.listen();
			try {
				built = makeSupervisor((cred) => (cred.uid === '1' ? authFail.url : server.url));
				await built.sup.start([entry(1), entry(2)]);

				await waitUntil(() => built!.sup.agents[0]?.status === 'offline', 'identity 1 degraded');
				await waitUntil(() => built!.sup.agents[1]?.status === 'online', 'identity 2 online');
				expect(built.clients[0]!.closed).toBe(true);
				expect(built.clients[1]!.isConnected).toBe(true);

				// 身份 2 的消息照常处理
				server.sendFrom(0, msg('identity-2'));
				await waitUntil(() => (built!.handled.get('2')?.length ?? 0) === 1, 'identity 2 still served');
				expect(built.handled.get('1')?.length ?? 0).toBe(0);

				// 身份 1 不再重试
				const attempts = authFail.upgradeRequests;
				await sleep(300);
				expect(authFail.upgradeRequests).toBe(attempts);
			} finally {
				await authFail.dispose();
			}
		},
		15000,
	);

	it(
		'permanent auth error stops that identity retries (circuit broken, terminal offline)',
		async () => {
			server.mode = 'reject401';
			await server.listen();
			built = makeSupervisor(() => server.url);
			await built.sup.start([entry(1)]);

			await waitUntil(() => built!.sup.agents[0]?.status === 'offline', 'degraded to offline');
			expect(built.clients[0]!.closed).toBe(true);
			expect(built.destroyed.get('1')).toHaveBeenCalledTimes(1);

			const attempts = server.upgradeRequests;
			await sleep(400);
			expect(server.upgradeRequests).toBe(attempts); // 断路：不再握手
		},
		15000,
	);
});
