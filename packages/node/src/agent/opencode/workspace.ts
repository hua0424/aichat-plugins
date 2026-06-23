import { join } from 'node:path';

/**
 * REQ-008 #77 — the chat-context shape the opencode driver needs to isolate workspaces.
 * roomType: 1=GROUP, 2=FRIEND(1:1 DM); counterpartUid present for DMs (the other party).
 * isOwner: for DMs, whether the counterpart is the aiclaw's OWNER — read from the inbound
 *   WS message's `message.aiclaw.isOwner` (server fills it; present only on DM pushes).
 */
export interface OpencodeChatContext {
	roomType: number;
	roomId: number;
	counterpartUid?: number;
	isOwner?: boolean;
}

/**
 * PURE — derive the per-conversation opencode workspace directory under `base`.
 *
 *  - owner DM (roomType===2 && isOwner) → <base>/owner   (the aiclaw's owner gets a stable alias)
 *  - friend DM (roomType===2)           → <base>/dm/<counterpartUid>  (one dir per peer)
 *  - group (roomType===1)               → <base>/group/<roomId>
 *  - unknown roomType                   → conservative group-by-roomId fallback
 *
 * owner vs friend is distinguished by `message.aiclaw.isOwner` on the inbound message
 * (server-computed senderUid==ownerUid; AiclawExt is present only on DM pushes).
 */
export function deriveWorkspaceDir(base: string, ctx: OpencodeChatContext): string {
	if (ctx.roomType === 2) {
		if (ctx.isOwner) {
			return join(base, 'owner');
		}
		// friend DM: isolate by the counterpart. counterpartUid should be set for DMs; if it is
		// somehow missing, fall back to roomId so we never collide all DMs into one dir.
		const peer = ctx.counterpartUid ?? ctx.roomId;
		return join(base, 'dm', String(peer));
	}
	if (ctx.roomType === 1) {
		return join(base, 'group', String(ctx.roomId));
	}
	// ponytail: unknown roomType → conservative group-by-roomId fallback (no new abstraction,
	// reuse the group layout) until a real new room type appears that needs its own handling.
	return join(base, 'group', String(ctx.roomId));
}
