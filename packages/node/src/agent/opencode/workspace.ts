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
 * REQ-008 #77 fix: ALWAYS namespaced by `aiclawUid` first so two opencode identities never
 * collide on the shared `owner` / `group` / `dm` sub-dirs. (Latent gap before this slice:
 * the layout had no per-identity segment, so e.g. two aiclaws both DMing their OWNER, or
 * both in the same group/roomId, would have shared one workspace dir.)
 *
 *  - owner DM (roomType===2 && isOwner) → <base>/<aiclawUid>/owner   (the aiclaw's owner gets a stable alias)
 *  - friend DM (roomType===2)           → <base>/<aiclawUid>/dm/<counterpartUid>  (one dir per peer)
 *  - group (roomType===1)               → <base>/<aiclawUid>/group/<roomId>
 *  - unknown roomType                   → conservative group-by-roomId fallback
 *
 * owner vs friend is distinguished by `message.aiclaw.isOwner` on the inbound message
 * (server-computed senderUid==ownerUid; AiclawExt is present only on DM pushes).
 */
export function deriveWorkspaceDir(base: string, aiclawUid: number, ctx: OpencodeChatContext): string {
	// #77 fix: per-identity root segment — never let two aiclaws share a conversation dir.
	const root = join(base, String(aiclawUid));
	if (ctx.roomType === 2) {
		if (ctx.isOwner) {
			return join(root, 'owner');
		}
		// friend DM: isolate by the counterpart. counterpartUid should be set for DMs; if it is
		// somehow missing, fall back to roomId so we never collide all DMs into one dir.
		const peer = ctx.counterpartUid ?? ctx.roomId;
		return join(root, 'dm', String(peer));
	}
	if (ctx.roomType === 1) {
		return join(root, 'group', String(ctx.roomId));
	}
	// ponytail: unknown roomType → conservative group-by-roomId fallback (no new abstraction,
	// reuse the group layout) until a real new room type appears that needs its own handling.
	return join(root, 'group', String(ctx.roomId));
}
