#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ccChannelPort } from './channel-endpoint.js';

/**
 * REQ-011 S2 — the `aichat-channel` stdio MCP (also this package's `aichat-channel` bin entry).
 *
 * claude-code loads this as a persistent (`claude mcp add -s user`) MCP. It declares the
 * `experimental: claude/channel` capability so CC's channels subsystem treats its
 * `notifications/claude/channel` notifications as inbound channel messages. The MCP opens a `ws`
 * client to the node-side CcChannelEndpoint, subscribes with the binding it inherits via
 * `$AICHAT_BIND`, and relays each pushed `{type:'message',content}` frame into CC's session.
 *
 * Why a persistent MCP (vs. `--mcp-config`): `--mcp-config` MCPs are invisible to the channels
 * subsystem; only user-scoped registered MCPs are wired into channels. AICHAT_BIND is read from the
 * inherited launch env, so no `-e` is needed when registering.
 *
 * `makeChannelNotification` and `shouldSubscribe` are the pure, unit-testable core. `run()` (the
 * stdio + ws side-effects) executes ONLY when this file is the process entrypoint, so importing the
 * pure exports in a test spawns nothing.
 */

/** The `claude/channel` notification this MCP pushes for an inbound message frame. */
interface ChannelNotification {
	method: 'notifications/claude/channel';
	params: { content: string; meta?: object };
}

/**
 * Map a parsed ws frame → a `claude/channel` notification, or undefined if the frame is not an
 * inbound message (`{type:'message', content}`). `meta` is included only when the frame carries it.
 */
export function makeChannelNotification(frame: unknown): ChannelNotification | undefined {
	if (!frame || typeof frame !== 'object') return undefined;
	const f = frame as Record<string, unknown>;
	if (f.type !== 'message' || typeof f.content !== 'string') return undefined;
	const meta = f.meta && typeof f.meta === 'object' ? (f.meta as object) : undefined;
	return { method: 'notifications/claude/channel', params: { content: f.content, ...(meta ? { meta } : {}) } };
}

/**
 * Decide whether to subscribe: the binding token comes ONLY from `$AICHAT_BIND`. Absent/empty →
 * undefined (the MCP stays idle and never subscribes — it can load harmlessly in a non-CC session).
 */
export function shouldSubscribe(env: NodeJS.ProcessEnv): string | undefined {
	const bind = env.AICHAT_BIND;
	return typeof bind === 'string' && bind.length > 0 ? bind : undefined;
}

/** Backoff ladder for ws reconnects (ms), capped at the last entry. */
const BACKOFF_MS = [1000, 2000, 4000, 8000, 10000];

/**
 * Build the low-level MCP server with the `claude/channel` experimental capability + an empty
 * tools/list (the low-level Server needs a handler registered or tools/list errors).
 */
function buildServer(): Server {
	const server = new Server(
		{ name: 'aichat-channel', version: '0.1.0' },
		{ capabilities: { experimental: { 'claude/channel': {} }, tools: {} } },
	);
	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
	return server;
}

/** Open the ws subscription, relaying pushed messages → channel notifications; reconnect on drop. */
function subscribe(server: Server, bind: string): void {
	let attempt = 0;
	const open = () => {
		const ws = new WebSocket(`ws://127.0.0.1:${ccChannelPort()}`);
		ws.on('open', () => {
			attempt = 0; // reset backoff on a successful connect
			ws.send(JSON.stringify({ type: 'subscribe', bindToken: bind }));
		});
		ws.on('message', (raw: Buffer) => {
			let frame: unknown;
			try {
				frame = JSON.parse(raw.toString('utf-8'));
			} catch {
				return;
			}
			const payload = makeChannelNotification(frame);
			if (payload) void server.notification(payload);
		});
		const reconnect = () => {
			const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
			attempt++;
			setTimeout(open, delay);
		};
		ws.on('close', reconnect);
		ws.on('error', () => ws.close());
	};
	open();
}

/** Boot the MCP over stdio, then (only if bound) open the channel subscription. */
async function run(): Promise<void> {
	const server = buildServer();
	await server.connect(new StdioServerTransport());
	const bind = shouldSubscribe(process.env);
	if (bind) subscribe(server, bind);
}

// Entrypoint guard: run() only when executed directly (the bin), never on import (the tests import
// only the pure exports above). Mirrors the ESM idiom for an importable-yet-runnable module.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	void run();
}
