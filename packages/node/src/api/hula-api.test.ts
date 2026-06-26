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

	it('JSON null workspaceDir → undefined (NOT the string "null"); account passes through', async () => {
		// REQ-009 #85 deploy bug: server sends workspace_dir as JSON null (default). `=== undefined`
		// missed it → String(null) = "null" → deriveWorkspaceDir treated "null" as an absolute override
		// → opencode session.create(directory:"null") failed the whole group round. `== null` fixes it.
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			okResponse({
				success: true,
				code: 0,
				data: [{ roomId: '163347643904512', workspaceDir: null, account: 'hula_kNpGV4Ij' }],
			}),
		);
		const client = new HulaApiClient('http://host:8080', 'tok');
		const list = await client.listSelfGroupConfigs();
		expect(list[0].workspaceDir).toBeUndefined();
		expect(list[0].account).toBe('hula_kNpGV4Ij');
	});

	it('data 缺失时返回空数组', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			okResponse({ success: true, code: 0 }),
		);
		const client = new HulaApiClient('http://host:8080', 'tok');

		await expect(client.listSelfGroupConfigs()).resolves.toEqual([]);
	});
});

describe('HulaApiClient query methods (REQ-010 S3 #93)', () => {
	it('getMemberInfo: GET /api/im/user/getById/{uid}, returns data profile object', async () => {
		const profile = { uid: 555, name: 'Alice', account: 'alice01', avatar: 'a.png', sex: 1 };
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			okResponse({ success: true, code: 0, data: profile }),
		);
		const client = new HulaApiClient('http://host:8080/', 'tok-abc');

		const out = await client.getMemberInfo(555);

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0];
		expect(url).toBe('http://host:8080/api/im/user/getById/555');
		expect((init as RequestInit).method).toBe('GET');
		expect((init as RequestInit).headers).toMatchObject({ token: 'tok-abc' });
		expect(out).toEqual(profile);
	});

	it('getMemberInfo: missing data → {} ', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse({ success: true, code: 0 }));
		const client = new HulaApiClient('http://host:8080', 'tok');
		await expect(client.getMemberInfo(1)).resolves.toEqual({});
	});

	it('listFriends: GET /api/im/user/friend/page?pageSize=<n>, maps data.list to {uid,name,account,remark}', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			okResponse({
				success: true,
				code: 0,
				data: {
					cursor: 'c1',
					isLast: true,
					list: [
						{ uid: '111', name: 'Bob', account: 'bob', remark: 'pal', avatar: 'b.png', userType: 1 },
						{ uid: '222', name: 'Cara', account: 'cara' },
					],
				},
			}),
		);
		const client = new HulaApiClient('http://host:8080', 'tok');

		const out = await client.listFriends(100);

		const [url, init] = fetchSpy.mock.calls[0];
		expect(url).toBe('http://host:8080/api/im/user/friend/page?pageSize=100');
		expect((init as RequestInit).method).toBe('GET');
		expect(out).toEqual([
			{ uid: 111, name: 'Bob', account: 'bob', remark: 'pal' },
			{ uid: 222, name: 'Cara', account: 'cara', remark: undefined },
		]);
		// uid coerced from server string to number
		expect(typeof out[0].uid).toBe('number');
	});

	it('listFriends: defaults pageSize to 100; missing data.list → []', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			okResponse({ success: true, code: 0, data: {} }),
		);
		const client = new HulaApiClient('http://host:8080', 'tok');
		const out = await client.listFriends();
		const [url] = fetchSpy.mock.calls[0];
		expect(url).toBe('http://host:8080/api/im/user/friend/page?pageSize=100');
		expect(out).toEqual([]);
	});

	it('searchUsers: GET /api/im/user/search?keyword=<kw> (param keyword, encoded), maps data.list', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			okResponse({
				success: true,
				code: 0,
				data: {
					pageNo: 1,
					pageSize: 10,
					totalRecords: 1,
					isLast: true,
					list: [{ uid: '333', name: 'Dee', avatar: 'd.png', account: 'dee', userType: 2 }],
				},
			}),
		);
		const client = new HulaApiClient('http://host:8080', 'tok');

		const out = await client.searchUsers('hi there');

		const [url] = fetchSpy.mock.calls[0];
		expect(url).toBe('http://host:8080/api/im/user/search?keyword=hi%20there');
		expect(out).toEqual([{ uid: 333, name: 'Dee', account: 'dee', userType: 2 }]);
		expect(typeof out[0].uid).toBe('number');
	});

	it('searchUsers: missing data.list → []', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse({ success: true, code: 0, data: {} }));
		const client = new HulaApiClient('http://host:8080', 'tok');
		await expect(client.searchUsers('x')).resolves.toEqual([]);
	});
});

describe('HulaApiClient.reportAgentType (REQ-009 #83)', () => {
	it('POST /api/im/aiclaw/report-agent-type with body { agentType }, token via header', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			okResponse({ success: true, code: 0 }),
		);
		const client = new HulaApiClient('http://host:8080/', 'tok-abc');

		await client.reportAgentType('opencode');

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0];
		expect(url).toBe('http://host:8080/api/im/aiclaw/report-agent-type');
		expect((init as RequestInit).method).toBe('POST');
		expect((init as RequestInit).headers).toMatchObject({ token: 'tok-abc' });
		expect(JSON.parse((init as RequestInit).body as string)).toEqual({ agentType: 'opencode' });
	});
});
