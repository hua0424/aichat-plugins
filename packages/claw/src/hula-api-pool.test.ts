import { describe, it, expect } from 'vitest';
import { HulaApiClientPool } from './hula-api-pool.js';

describe('HulaApiClientPool.get identity safety', () => {
	it('single-token mode: unknown uid falls back to default (back-compat)', () => {
		const pool = new HulaApiClientPool('http://x');
		pool.setDefault('tok-default');
		// 池为空，未知 uid 回退默认（单 token 部署，默认即本进程唯一身份）
		expect(() => pool.get('100')).not.toThrow();
		expect(pool.get('100')).toBe(pool.get());
	});

	it('multi-token mode: registered uid returns its own client', () => {
		const pool = new HulaApiClientPool('http://x');
		pool.setDefault('tok-default');
		pool.register('100', 'tok-100');
		pool.register('200', 'tok-200');
		const c100 = pool.get('100');
		const c200 = pool.get('200');
		expect(c100).not.toBe(c200);
		expect(c100).not.toBe(pool.get()); // 不是默认
	});

	it('multi-token mode: unknown uid is REJECTED (no wrong-identity fallback)', () => {
		const pool = new HulaApiClientPool('http://x');
		pool.setDefault('tok-default');
		pool.register('100', 'tok-100');
		// 池非空 = 多 token 模式，未命中绝不冒名回退默认
		expect(() => pool.get('999')).toThrow(/multi-token/);
	});

	it('no uid requested returns default', () => {
		const pool = new HulaApiClientPool('http://x');
		pool.setDefault('tok-default');
		expect(() => pool.get()).not.toThrow();
	});

	it('throws when nothing registered', () => {
		const pool = new HulaApiClientPool('http://x');
		expect(() => pool.get('100')).toThrow(/No HulaApiClient available/);
	});
});
