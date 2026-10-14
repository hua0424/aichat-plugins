import type { OpenClawPluginApi } from './types.js';
import { hulaChannel } from './channel/index.js';
import { buildOpenclawExecEnv, extractExecEnvSessionKey } from './exec-env.js';
import { handleBeforeToolCall } from './run-exec-bridge.js';

/**
 * aichat-claw Plugin 入口（aichatoverview#161 — ADR-0004 收尾；#406 追加 exec 可信桥）
 *
 * 退役 Agent Tools 后，claw 做三件事：
 *  1. 注册 HuLa Channel——openclaw 据此路由 direct/group 聊天；
 *  2. 注册 `resolve_exec_env` hook——把复合 sessionKey 的 token 前缀注入 OPENCLAW_BIND，
 *     让 openclaw agent 在 exec 里跑统一的 `aichat send-message` CLI 回复（与 opencode/codex/cc 一致）；
 *  3. 注册 `before_tool_call` hook（#406）——可信 ctx.runId 取得本 run 冻结 token 并写
 *     exec params.env 的固定 `AICHAT_RUN_BIND`（覆盖/清除模型自报与继承值；无精确文件
 *     即空值 fail-closed）。resolve 路径绝不输出该 key，故最终 env 以此处为准。
 *
 * 回复不再经插件内的 hula_send_message / hula_find_friend / hula_skip_reply 工具，
 * 也不再持有独立的 HuLa API 客户端——凭据信任点收敛到 aichat-node 单一 server 节点。
 */
export default function register(api: OpenClawPluginApi) {
	api.logger.info('aichat-claw loading');

	// 注册 HuLa Channel（无 outbound 适配器；回复走 aichat CLI，ADR-0004）
	api.registerChannel({ plugin: hulaChannel });

	// REQ-010 S6 Phase-2 / #141 B+: openclaw agent CAN run shell（exec 工具），故统一走
	// `aichat send-message` CLI。复合 sessionKey 是 `agent:main:<token>:aiclaw-{uid}-room-{roomId}`；
	// buildOpenclawExecEnv 剥掉命名空间前缀、抽出 token 前缀注入 OPENCLAW_BIND → CLI 的
	// resolveAgentSessionKey() 读它 → 发 `openclaw:<token>` 给 node CapabilityEndpoint 精确反查。
	// 非良构 sessionKey 返回 {}（不注入）——绝不 throw、绝不注入畸形值。
	if (typeof api.on === 'function') {
		api.on(
			'resolve_exec_env',
			(event, ctx) => {
				const sessionKey = extractExecEnvSessionKey(event, ctx);
				const env = buildOpenclawExecEnv(sessionKey);
				if (env.OPENCLAW_BIND) {
					api.logger.info(`aichat-claw resolve_exec_env: injecting OPENCLAW_BIND=${env.OPENCLAW_BIND}`);
				}
				return env;
			},
			{ priority: 100 },
		);
		api.logger.info('aichat-claw: registered resolve_exec_env hook (OPENCLAW_BIND injection)');
		// #406: 可信 exec 桥。before_tool_call 事件带可信 runId/toolCallId（2026.6.5 实装），
		// 仅 exec 工具调用写入固定 AICHAT_RUN_BIND；无精确映射即空值（fail-closed），绝不
		// 猜配、绝不 throw（handler 内部已兜底；此处再包一层，hook  runner 本来也会吞错）。
		// 注意绝不在此记录 token 值（desensitized：只记 run 摘要，见 run-exec-bridge）。
		api.on(
			'before_tool_call',
			async (event, ctx) => {
				try {
					return await handleBeforeToolCall({ event, ctx });
				} catch {
					return undefined;
				}
			},
			{ priority: 100 },
		);
		api.logger.info('aichat-claw: registered before_tool_call hook (AICHAT_RUN_BIND bridge)');
	}

	api.logger.info('aichat-claw loaded: channel=hula (replies via aichat CLI)');
}
