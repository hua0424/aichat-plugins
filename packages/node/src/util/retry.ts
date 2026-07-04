/**
 * BL-015 / #140：有界退避重试。
 *
 * HuLa-Server 重启后的 Nacos 重注册窗口（约 1 分钟）内，WS 重连触发的两个幂等动作
 * （prewarmGroupConfigs / reportAgentType）会失败且无重试，把 node 留在降级态
 * （群配置过期 / agent 类型未上报）直到人工重启。二者幂等 → 加有界退避重试即可自愈。
 *
 * 语义：fire-and-forget —— 本函数**永不 reject**。用尽次数后记一行 error 并返回，
 * 调用方（ws onConnected）不得因此崩溃/阻塞收消息。日志沿用 supervisor.ts 既有单行风格。
 */
export interface RetryOptions {
	/** 日志标签，如 'prewarm' / 'reportAgentType'。 */
	label: string;
	/** 最大尝试次数（含首次）。默认 8。 */
	tries?: number;
	/** 第 attempt 次（1-based）失败后的退避毫秒。默认指数 1s→30s 封顶。 */
	backoffMs?: (attempt: number) => number;
	/** 延时实现，测试可注入即时 resolve。默认 setTimeout。 */
	delay?: (ms: number) => Promise<void>;
}

const defaultBackoffMs = (attempt: number): number => Math.min(1000 * 2 ** (attempt - 1), 30000);
const defaultDelay = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

export async function retryAsync(fn: () => Promise<void>, opts: RetryOptions): Promise<void> {
	const { label } = opts;
	const tries = opts.tries ?? 8;
	const backoffMs = opts.backoffMs ?? defaultBackoffMs;
	const delay = opts.delay ?? defaultDelay;

	for (let attempt = 1; attempt <= tries; attempt++) {
		try {
			await fn();
			if (attempt > 1) {
				console.log(`[retry] ${label} succeeded on attempt ${attempt}/${tries}`);
			}
			return;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (attempt === tries) {
				console.error(`[retry] ${label} gave up after ${tries} attempts: ${msg}`);
				return;
			}
			console.warn(`[retry] ${label} attempt ${attempt}/${tries} failed: ${msg}; retrying...`);
			await delay(backoffMs(attempt));
		}
	}
}
