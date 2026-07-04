import { describe, it, expect, vi, afterEach } from 'vitest';
import { retryAsync } from './retry.js';

/** 即时 delay + 极小 backoff，避免测试真的等待。 */
const instant = { delay: () => Promise.resolve(), backoffMs: () => 0 };

afterEach(() => {
	vi.restoreAllMocks();
});

describe('retryAsync', () => {
	it('首次成功：fn 只调用一次，无 warn/error 日志', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const fn = vi.fn().mockResolvedValue(undefined);

		await retryAsync(fn, { label: 'x', ...instant });

		expect(fn).toHaveBeenCalledTimes(1);
		expect(warn).not.toHaveBeenCalled();
		expect(error).not.toHaveBeenCalled();
		// 首次成功保持安静（不打成功行）。
		expect(log).not.toHaveBeenCalled();
	});

	it('失败两次后第 3 次成功：fn 调 3 次，resolve，打一条成功日志', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const fn = vi
			.fn()
			.mockRejectedValueOnce(new Error('boom1'))
			.mockRejectedValueOnce(new Error('boom2'))
			.mockResolvedValueOnce(undefined);

		await expect(retryAsync(fn, { label: 'prewarm', tries: 5, ...instant })).resolves.toBeUndefined();

		expect(fn).toHaveBeenCalledTimes(3);
		expect(warn).toHaveBeenCalledTimes(2);
		expect(error).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalledWith('[retry] prewarm succeeded on attempt 3/5');
	});

	it('始终失败：fn 恰好调 tries 次，resolve（不 reject），打一条 give-up error', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const fn = vi.fn().mockRejectedValue(new Error('always'));

		await expect(retryAsync(fn, { label: 'reportAgentType', tries: 4, ...instant })).resolves.toBeUndefined();

		expect(fn).toHaveBeenCalledTimes(4);
		// 前 3 次 warn，最后一次 give-up。
		expect(warn).toHaveBeenCalledTimes(3);
		expect(error).toHaveBeenCalledTimes(1);
		expect(error).toHaveBeenCalledWith('[retry] reportAgentType gave up after 4 attempts: always');
	});

	it('backoffMs 按 attempt 序号被调用于每次失败后', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const backoffMs = vi.fn(() => 0);
		const fn = vi.fn().mockRejectedValue(new Error('nope'));

		await retryAsync(fn, { label: 'x', tries: 3, delay: () => Promise.resolve(), backoffMs });

		// 3 次尝试 → 2 次退避（最后一次 give-up 不退避）。
		expect(backoffMs.mock.calls).toEqual([[1], [2]]);
	});

	// BL-015 / #140: WS flapping —— onConnected 多次触发（重连抖动）会各起一条独立重试链。
	// manager 批准的取舍是「stack 但每条各自有界 + 幂等」。本用例钉住有界性：N 次调用、每次都用
	// 恒失败 fn，总调用数恰为 N*tries，且每条链都 resolve（永不 hang、永不越过自己的 tries 上限）。
	it('flapping stacks but stays bounded: N 次独立 retryAsync（恒失败）→ 恰好 N*tries 次调用，每条都 resolve', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const N = 4;
		const tries = 3;
		// 每条链一个独立的恒失败 fn（模拟每次 onConnected 各自触发的 prewarm/reportAgentType）。
		const fns = Array.from({ length: N }, () => vi.fn().mockRejectedValue(new Error('always')));

		// 并发触发 N 条链（stack），全部必须落地 resolve（fire-and-forget 契约：永不 reject/hang）。
		await Promise.all(
			fns.map((fn) => expect(retryAsync(fn, { label: 'flap', tries, ...instant })).resolves.toBeUndefined()),
		);

		// 每条链独立有界：恰好 tries 次，从不越顶。
		for (const fn of fns) {
			expect(fn).toHaveBeenCalledTimes(tries);
		}
		// 全局：总调用数正好是 N*tries（stack 不会相互放大）。
		const total = fns.reduce((sum, fn) => sum + fn.mock.calls.length, 0);
		expect(total).toBe(N * tries);
	});
});
