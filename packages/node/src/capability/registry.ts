import { HulaApiRejectedError, type HulaApiClient } from '../api/hula-api.js';
import { errMsg } from '../util/err.js';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * REQ-010 S1 — capability execution context.
 *
 * The identity (`aiclawUid`) and target `roomId` are RESOLVED by node from the agent's session
 * (never from the CLI / capability args), and the per-identity `apiClient` is the only way a
 * capability can reach HuLa-Server. Capabilities read room/identity from HERE, never from args —
 * this is the anti-spoofing seam.
 */
export interface CapabilityContext {
	// REQ-029 (#29): aiclawUid/roomId are opaque strings (resolved from the agent session).
	aiclawUid: string;
	roomId: string;
	apiClient: HulaApiClient;
	/** Endpoint-owned reset receipt correlation; never populated from capability args. */
	requestId?: string;
	/** Core-resolved generation, not caller-supplied; part of the T15 payload fingerprint. */
	generation?: number;
	/** Set only after a successful, explicit T15 capability probe. */
	receiptSupported?: boolean;
	resetBearer?: string;
}

export class CapabilityRejectedError extends Error {}
export class CapabilityPersistenceError extends Error {}
export class ReceiptProbeError extends Error {}

/** Timestamp-shaped IDs permit bounded retries, including explicit reuse after restart; syntax is not provenance. */
export function autoRetrySafe(requestId: string | undefined, now = Date.now()): boolean {
	const match = /^r([0-9a-z]+)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(requestId ?? '');
	if (!match) return false;
	const created = Number.parseInt(match[1], 36);
	return Number.isSafeInteger(created) && created <= now && now - created < 7 * 24 * 60 * 60 * 1000;
}

/** A node-local capability: pure-ish, gets a bound context + opaque args, returns a JSON result. */
export type Capability = (ctx: CapabilityContext, args: Record<string, unknown>) => Promise<unknown>;

/** A tiny name → Capability registry. */
export class CapabilityRegistry {
	private readonly caps = new Map<string, Capability>();

	register(name: string, cap: Capability): void {
		this.caps.set(name, cap);
	}

	has(name: string): boolean {
		return this.caps.has(name);
	}

	async invoke(name: string, ctx: CapabilityContext, args: Record<string, unknown>): Promise<unknown> {
		const cap = this.caps.get(name);
		if (!cap) throw new Error(`unknown capability: ${name}`);
		return cap(ctx, args);
	}
}

/**
 * REQ-010 S1 — the `send-message` capability: reply into the chat bound to ctx.
 *
 * Reads only `args.content` (a non-empty string, trimmed). The room/identity come from ctx ONLY —
 * any `args.room` / identity field is IGNORED (anti-spoofing). Throws on missing/empty content.
 */
export function sendMessageCapability(): Capability {
	return async (ctx, args) => {
		const raw = args.content;
		if (typeof raw !== 'string' || raw.trim().length === 0) {
			throw new Error('send-message: `content` is required and must be a non-empty string');
		}
		const content = raw.trim();
		try { ctx.receiptSupported = await ctx.apiClient.supportsMessageReceipts(); }
		catch (err) {
			if (err instanceof HulaApiRejectedError) throw err;
			throw new ReceiptProbeError('receipt capability probe unavailable; no write started');
		}
		if (ctx.receiptSupported && !ctx.requestId) throw new Error('send-message: missing requestId');
		// Old server: one legacy attempt, never retry an uncertain write or assume ignored fields work.
		const attempts = ctx.receiptSupported && autoRetrySafe(ctx.requestId) ? 3 : 1;
		for (let attempt = 0; attempt < attempts; attempt++) {
			if (attempt > 0 && !autoRetrySafe(ctx.requestId)) throw new Error('receipt retry window elapsed');
			try {
				const { msgId } = ctx.receiptSupported
					? await ctx.apiClient.sendMessage(ctx.roomId, content, { cliGeneration: ctx.generation }, ctx.requestId)
					: await ctx.apiClient.sendMessage(ctx.roomId, content);
				if (!/^\d+$/.test(msgId) || msgId === '0') throw new Error('send-message: missing committed msgId');
				return { msgId, roomId: ctx.roomId, receiptMode: ctx.receiptSupported ? 'durable' : 'legacy' };
			} catch (err) {
				if (err instanceof HulaApiRejectedError || attempt === attempts - 1) throw err;
				await delay(200 * (attempt + 1));
			}
		}
		throw new Error('send-message: result unknown');
	};
}

/**
 * aichatoverview#124 — reset the agent session bound to ctx (identity+room come from the resolved
 * session, never args → anti-spoofing). Delegates to a `resetFor` closure (injected at registration)
 * that owns the identity→driver dispatch. Returns which driver handled it + whether per-room state
 * was actually reset (false = stateless driver like openclaw, a no-op).
 */
export function resetSessionCapability(
	resetFor: (aiclawUid: string, roomId: string, requestId?: string, bearer?: string) => { driverType: string; reset: boolean; generation?: number; executionPaused?: boolean; cancelRunId?: string } | undefined,
): Capability {
	return async (ctx) => {
		let r: ReturnType<typeof resetFor>;
		try {
			r = ctx.requestId === undefined
				? resetFor(ctx.aiclawUid, ctx.roomId)
				: resetFor(ctx.aiclawUid, ctx.roomId, ctx.requestId, ctx.resetBearer);
		} catch { throw new CapabilityPersistenceError('reset receipt persistence unavailable'); }
		if (!r) throw new CapabilityRejectedError('reset-session: no live agent for this identity');
		return { roomId: ctx.roomId, driverType: r.driverType, reset: r.reset,
			...(r.generation === undefined ? {} : { generation: r.generation, executionPaused: r.executionPaused }),
			...(r.cancelRunId === undefined ? {} : { cancelRunId: r.cancelRunId }) };
	};
}

/**
 * REQ-010 S3 — read-only query capabilities (member-info / list-friends / find-friend).
 *
 * ANTI-SPOOFING: identity/scope come ONLY from the resolved `ctx.apiClient` (the aiclaw's token,
 * derived from the agent session key) — they are NEVER read from args. The `uid` / `keyword` below
 * are legitimate QUERY TARGETS (what to look up), not identity claims, so they correctly live in
 * args. These caps intentionally IGNORE `ctx.roomId`: they are aiclaw-scoped queries (whoever this
 * aiclaw's token can see), not room-scoped — the token, not the room, bounds what they return.
 */

/** member-info: look up one user's public profile by `args.uid`. */
export function memberInfoCapability(): Capability {
	return async (ctx, args) => {
		const raw = args.uid;
		// REQ-029 (#29): keep uid as an opaque numeric string (never Number() — >2^53 corrupts). The uid
		// is a QUERY TARGET, validated as a non-empty positive-integer string.
		const uid = typeof raw === 'number' || typeof raw === 'string' ? String(raw) : '';
		if (!/^\d+$/.test(uid) || uid === '0') {
			throw new HulaApiRejectedError('member-info: `uid` is required and must be a positive integer');
		}
		const profile = await ctx.apiClient.getMemberInfo(uid);
		return { uid, profile };
	};
}

/** list-friends: the aiclaw's own friend list (no args; token-scoped). */
export function listFriendsCapability(): Capability {
	return async (ctx) => {
		const friends = await ctx.apiClient.listFriends();
		return { friends };
	};
}

/** find-friend: search users by `args.keyword` (non-empty, trimmed). */
export function findFriendCapability(): Capability {
	return async (ctx, args) => {
		const raw = args.keyword;
		if (typeof raw !== 'string' || raw.trim().length === 0) {
			throw new HulaApiRejectedError('find-friend: `keyword` is required and must be a non-empty string');
		}
		const keyword = raw.trim();
		const users = await ctx.apiClient.searchUsers(keyword);
		return { keyword, users };
	};
}

/**
 * REQ-010 S4 — group query capabilities (list-groups / list-group-members).
 *
 * ANTI-SPOOFING: identity/scope come ONLY from the resolved `ctx.apiClient` (the aiclaw's token,
 * from the agent session key). `--groupid` below is a QUERY TARGET (a room the agent names), NOT an
 * identity claim — the server enforces that the aiclaw actually joined it. node NEVER judges room
 * type: it always passes the roomId through; the server is the authority and returns a structured
 * business error ("当前不在群聊中" / "未加入该群聊，无法查询成员"), which we pass through to the agent
 * as an `error` field (CLI exit 0) rather than a hard failure.
 */

/** list-groups: the groups this aiclaw has joined (no args; token-scoped). */
export function listGroupsCapability(): Capability {
	return async (ctx) => {
		return { groups: await ctx.apiClient.listGroups() };
	};
}

/**
 * list-group-members: members (with online status) of a joined group.
 * Default target is the current session's room (ctx.roomId); `args.groupid` overrides to a DIFFERENT
 * joined group. `args.online` filters to online members only.
 */
export function listGroupMembersCapability(): Capability {
	return async (ctx, args) => {
		let roomId: string;
		if (args.groupid != null) {
			// REQ-029 (#29): keep as an opaque numeric string (never Number() — >2^53 corrupts routing).
			roomId = String(args.groupid);
			if (!/^\d+$/.test(roomId) || roomId === '0') {
				throw new HulaApiRejectedError('list-group-members: invalid --groupid');
			}
		} else {
			roomId = ctx.roomId;
		}
		const online = args.online === true || args.online === 'true';
		try {
			const members = await ctx.apiClient.listGroupMembers(roomId, online);
			return { roomId, online, members };
		} catch (err) {
			// Keep the legacy exit-0 result.error for known business failures, but do not echo
			// arbitrary server/transport text: it can contain a credential.
			const message = errMsg(err);
			const business = /^HuLa API failed: (当前不在群聊中|未加入该群聊，无法查询成员)$/.test(message);
			const code = message === 'HuLa API failed: 未加入该群聊，无法查询成员' ? 'FORBIDDEN'
				: err instanceof HulaApiRejectedError ? err.code : 'UPSTREAM_FAILED';
			return { roomId, error: business ? message : code === 'FORBIDDEN' ? 'forbidden by API' : 'upstream query unavailable',
				code, retryable: code === 'UPSTREAM_FAILED' };
		}
	};
}
