import { describe, it, expect } from 'vitest';
import { getMachineCode } from './machine.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('getMachineCode', () => {
	it('两次调用返回不同的非空字符串（每个身份唯一 — 核心保证，见 #122）', () => {
		const a = getMachineCode();
		const b = getMachineCode();
		expect(a).toBeTruthy();
		expect(b).toBeTruthy();
		expect(a).not.toBe(b);
	});

	it('返回值是 UUID v4 形状', () => {
		expect(getMachineCode()).toMatch(UUID_V4);
	});
});
