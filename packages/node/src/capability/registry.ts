import type { HulaApiClient } from '../api/hula-api.js';

/**
 * REQ-010 S1 — capability execution context.
 *
 * The identity (`aiclawUid`) and target `roomId` are RESOLVED by node from the agent's session
 * (never from the CLI / capability args), and the per-identity `apiClient` is the only way a
 * capability can reach HuLa-Server. Capabilities read room/identity from HERE, never from args —
 * this is the anti-spoofing seam.
 */
export interface CapabilityContext {
	aiclawUid: number;
	roomId: number;
	apiClient: HulaApiClient;
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
		const { msgId } = await ctx.apiClient.sendMessage(ctx.roomId, content);
		return { msgId, roomId: ctx.roomId };
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
		const uid = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
		if (!Number.isInteger(uid) || uid <= 0) {
			throw new Error('member-info: `uid` is required and must be a positive integer');
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
			throw new Error('find-friend: `keyword` is required and must be a non-empty string');
		}
		const keyword = raw.trim();
		const users = await ctx.apiClient.searchUsers(keyword);
		return { keyword, users };
	};
}
