import type { OpenClawPluginApi } from './types.js';
import { hulaChannel } from './channel/index.js';
import { buildOpenclawExecEnv, extractExecEnvSessionKey } from './exec-env.js';

/**
 * aichat-claw Plugin 入口（aichatoverview#161 — ADR-0004 收尾）
 *
 * 退役 Agent Tools 后，claw 只做两件事：
 *  1. 注册 HuLa Channel——openclaw 据此路由 direct/group 聊天；
 *  2. 注册 `resolve_exec_env` hook——把复合 sessionKey 的 token 前缀注入 OPENCLAW_BIND，
 *     让 openclaw agent 在 exec 里跑统一的 `aichat send-message` CLI 回复（与 opencode/codex/cc 一致）。
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
	}

	api.logger.info('aichat-claw loaded: channel=hula (replies via aichat CLI)');
}
