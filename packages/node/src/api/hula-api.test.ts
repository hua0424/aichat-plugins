import { describe, it, expect, vi, afterEach } from 'vitest';
import { HulaApiClient } from './hula-api.js';

afterEach(() => {
	vi.restoreAllMocks();
});

/** 构造一个返回给定 JSON envelope 的 fake fetch Response */
function okResponse(json: unknown): Response {
	return {
		ok: true,
		status: 200,
		json: async () => json,
		text: async () => '',
	} as unknown as Response;
}

describe('HulaApiClient.listSelfGroupConfigs (REQ #26)', () => {
	it('GET /api/im/aiclaw/group/config/list 无 query，token 走 header', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			okResponse({ success: true, code: 0, data: [] }),
		);
		const client = new HulaApiClient('http://host:8080/', 'tok-abc');

		await client.listSelfGroupConfigs();

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0];
		expect(url).toBe('http://host:8080/api/im/aiclaw/group/config/list');
		expect((init as RequestInit).method).toBe('GET');
		expect((init as RequestInit).headers).toMatchObject({ token: 'tok-abc' });
	});

	it('listSelfGroupConfigsCoercesStringRoomId: server 的字符串 roomId/字段转 number', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			okResponse({
				success: true,
				code: 0,
				data: [
					{
						aiclawUid: '123456789012345678',
						roomId: '987654321098765432',
						mentionRequired: '0',
						respondToAi: '1',
						rateLimitPerMinute: '5',
						dailyLimit: '100',
					},
				],
			}),
		);
		const client = new HulaApiClient('http://host:8080', 'tok');

		const list = await client.listSelfGroupConfigs();

		expect(list).toHaveLength(1);
		const entry = list[0];
		expect(typeof entry.roomId).toBe('number');
		expect(entry.roomId).toBe(987654321098765432);
		expect(entry.mentionRequired).toBe(0);
		expect(entry.respondToAi).toBe(1);
		expect(entry.rateLimitPerMinute).toBe(5);
		expect(entry.dailyLimit).toBe(100);
	});

	it('data 缺失时返回空数组', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			okResponse({ success: true, code: 0 }),
		);
		const client = new HulaApiClient('http://host:8080', 'tok');

		await expect(client.listSelfGroupConfigs()).resolves.toEqual([]);
	});
});
