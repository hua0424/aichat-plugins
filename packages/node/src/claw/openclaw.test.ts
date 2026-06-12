import { describe, it, expect } from 'vitest';
import { buildConnectParams, parseHelloOk, classifyTerminalTool } from './openclaw.js';

describe('classifyTerminalTool (REQ-004 S3 terminal-action classifier)', () => {
	it('classifies hula_send_message as sent', () => {
		expect(classifyTerminalTool('hula_send_message', undefined)).toEqual({
			action: 'sent',
			tool: 'hula_send_message',
		});
	});

	it('classifies hula_skip_reply as skipped (no reason)', () => {
		expect(classifyTerminalTool('hula_skip_reply', undefined)).toEqual({
			action: 'skipped',
			tool: 'hula_skip_reply',
			reason: undefined,
		});
	});

	it('classifies hula_skip_reply as skipped and extracts reason from args', () => {
		expect(classifyTerminalTool('hula_skip_reply', { reason: '纯客套' })).toEqual({
			action: 'skipped',
			tool: 'hula_skip_reply',
			reason: '纯客套',
		});
	});

	it('classifies built-in message tool with channel:hula as sent', () => {
		expect(classifyTerminalTool('message', { channel: 'hula', text: 'hi' })).toEqual({
			action: 'sent',
			tool: 'message',
		});
	});

	it('ignores built-in message tool targeting a non-hula channel', () => {
		expect(classifyTerminalTool('message', { channel: 'slack', text: 'hi' })).toBeNull();
	});

	it('ignores built-in message tool with no channel', () => {
		expect(classifyTerminalTool('message', { text: 'hi' })).toBeNull();
	});

	// P2-1: channel 匹配容忍大小写/空白/数组形式（openclaw 可能归一化），语义仍锁定仅 hula
	it('classifies message tool with channel "Hula" (case-insensitive) as sent', () => {
		expect(classifyTerminalTool('message', { channel: 'Hula', text: 'hi' })).toEqual({
			action: 'sent',
			tool: 'message',
		});
	});

	it('classifies message tool with channel " hula " (trimmed whitespace) as sent', () => {
		expect(classifyTerminalTool('message', { channel: ' hula ', text: 'hi' })).toEqual({
			action: 'sent',
			tool: 'message',
		});
	});

	it('classifies message tool with channel ["hula"] (array form) as sent', () => {
		expect(classifyTerminalTool('message', { channel: ['hula'], text: 'hi' })).toEqual({
			action: 'sent',
			tool: 'message',
		});
	});

	it('ignores message tool with channel "discord" (string)', () => {
		expect(classifyTerminalTool('message', { channel: 'discord', text: 'hi' })).toBeNull();
	});

	it('ignores message tool with empty-string channel', () => {
		expect(classifyTerminalTool('message', { channel: '', text: 'hi' })).toBeNull();
	});

	it('ignores message tool with undefined channel', () => {
		expect(classifyTerminalTool('message', { channel: undefined, text: 'hi' })).toBeNull();
	});

	it('ignores message tool with channel ["discord"] (array form)', () => {
		expect(classifyTerminalTool('message', { channel: ['discord'], text: 'hi' })).toBeNull();
	});

	it('ignores unrelated tools (not a terminal action)', () => {
		expect(classifyTerminalTool('hula_find_friend', { query: 'bob' })).toBeNull();
		expect(classifyTerminalTool('some_other_tool', undefined)).toBeNull();
	});
});

describe('buildConnectParams', () => {
	const baseDevice = {
		id: 'device-123',
		publicKey: 'pubkey',
		signature: 'sig',
		signedAt: 1700000000000,
		nonce: 'nonce-abc',
	};

	const role = 'operator';
	const scopes = ['operator.admin', 'operator.read'];
	const platform = 'linux';

	it('negotiates protocol v4 (min and max)', () => {
		const params = buildConnectParams({
			token: 'tok',
			device: baseDevice,
			role,
			scopes,
			platform,
		});
		expect(params.minProtocol).toBe(4);
		expect(params.maxProtocol).toBe(4);
	});

	it('builds the client block with backend mode and aichat-node displayName', () => {
		const params = buildConnectParams({
			token: 'tok',
			device: baseDevice,
			role,
			scopes,
			platform,
		});
		const client = params.client as Record<string, unknown>;
		expect(client.mode).toBe('backend');
		expect(client.displayName).toBe('aichat-node');
		expect(client.id).toBe('gateway-client');
		expect(client.platform).toBe(platform);
	});

	it('includes device and auth when token present', () => {
		const params = buildConnectParams({
			token: 'tok',
			device: baseDevice,
			role,
			scopes,
			platform,
		});
		expect(params.device).toBe(baseDevice);
		expect(params.auth).toEqual({ token: 'tok' });
		expect(params.role).toBe(role);
		expect(params.scopes).toBe(scopes);
	});

	it('omits auth when no token', () => {
		const params = buildConnectParams({
			token: '',
			device: baseDevice,
			role,
			scopes,
			platform,
		});
		expect(params.auth).toBeUndefined();
	});

	it('omits auth when token undefined', () => {
		const params = buildConnectParams({
			device: baseDevice,
			role,
			scopes,
			platform,
		});
		expect(params.auth).toBeUndefined();
	});

	it('passes through undefined device', () => {
		const params = buildConnectParams({
			token: 'tok',
			device: undefined,
			role,
			scopes,
			platform,
		});
		expect(params.device).toBeUndefined();
	});
});

describe('parseHelloOk', () => {
	it('parses a valid v4 hello-ok', () => {
		const result = parseHelloOk({
			type: 'hello-ok',
			protocol: 4,
			server: { version: '2026.6.5', connId: 'abc' },
			policy: { tickIntervalMs: 15000 },
		});
		expect(result).toEqual({
			ok: true,
			protocol: 4,
			connId: 'abc',
			version: '2026.6.5',
			tickIntervalMs: 15000,
		});
	});

	it('parses a v3-style hello-ok with no protocol/connId', () => {
		const result = parseHelloOk({
			type: 'hello-ok',
			server: { version: 'x' },
		});
		expect(result.ok).toBe(true);
		expect(result.version).toBe('x');
		expect(result.protocol).toBeUndefined();
		expect(result.connId).toBeUndefined();
		expect(result.tickIntervalMs).toBeUndefined();
	});

	it('returns ok:true with no tickIntervalMs when policy missing', () => {
		const result = parseHelloOk({
			type: 'hello-ok',
			protocol: 4,
			server: { version: '2026.6.5', connId: 'abc' },
		});
		expect(result.ok).toBe(true);
		expect(result.tickIntervalMs).toBeUndefined();
		expect(result.protocol).toBe(4);
		expect(result.connId).toBe('abc');
	});

	it('ignores non-number tickIntervalMs', () => {
		const result = parseHelloOk({
			type: 'hello-ok',
			server: { version: 'x' },
			policy: { tickIntervalMs: 'fast' },
		});
		expect(result.ok).toBe(true);
		expect(result.tickIntervalMs).toBeUndefined();
	});

	it('ignores NaN tickIntervalMs', () => {
		const result = parseHelloOk({
			type: 'hello-ok',
			server: { version: 'x' },
			policy: { tickIntervalMs: NaN },
		});
		expect(result.ok).toBe(true);
		expect(result.tickIntervalMs).toBeUndefined();
	});

	it('ignores Infinity tickIntervalMs', () => {
		const result = parseHelloOk({
			type: 'hello-ok',
			server: { version: 'x' },
			policy: { tickIntervalMs: Infinity },
		});
		expect(result.ok).toBe(true);
		expect(result.tickIntervalMs).toBeUndefined();
	});

	it('ignores zero tickIntervalMs', () => {
		const result = parseHelloOk({
			type: 'hello-ok',
			server: { version: 'x' },
			policy: { tickIntervalMs: 0 },
		});
		expect(result.ok).toBe(true);
		expect(result.tickIntervalMs).toBeUndefined();
	});

	it('ignores negative tickIntervalMs', () => {
		const result = parseHelloOk({
			type: 'hello-ok',
			server: { version: 'x' },
			policy: { tickIntervalMs: -1 },
		});
		expect(result.ok).toBe(true);
		expect(result.tickIntervalMs).toBeUndefined();
	});

	it('accepts a valid positive tickIntervalMs', () => {
		const result = parseHelloOk({
			type: 'hello-ok',
			server: { version: 'x' },
			policy: { tickIntervalMs: 15000 },
		});
		expect(result.ok).toBe(true);
		expect(result.tickIntervalMs).toBe(15000);
	});

	it('treats empty-string connId as absent', () => {
		const result = parseHelloOk({
			type: 'hello-ok',
			protocol: 4,
			server: { version: 'x', connId: '' },
		});
		expect(result.ok).toBe(true);
		expect(result.connId).toBeUndefined();
	});

	it('ignores non-integer protocol and non-string connId', () => {
		const result = parseHelloOk({
			type: 'hello-ok',
			protocol: 'four',
			server: { version: 'x', connId: 123 },
		});
		expect(result.ok).toBe(true);
		expect(result.protocol).toBeUndefined();
		expect(result.connId).toBeUndefined();
	});

	it('returns ok:false for wrong type res', () => {
		expect(parseHelloOk({ type: 'res' })).toEqual({ ok: false });
	});

	it('returns ok:false for empty object', () => {
		expect(parseHelloOk({})).toEqual({ ok: false });
	});

	it('returns ok:false for null', () => {
		expect(parseHelloOk(null)).toEqual({ ok: false });
	});

	it('returns ok:false for undefined', () => {
		expect(parseHelloOk(undefined)).toEqual({ ok: false });
	});

	it('handles hello-ok with missing server block', () => {
		const result = parseHelloOk({ type: 'hello-ok', protocol: 4 });
		expect(result.ok).toBe(true);
		expect(result.protocol).toBe(4);
		expect(result.version).toBeUndefined();
		expect(result.connId).toBeUndefined();
	});
});
