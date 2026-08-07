import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentPromptTemplates } from './prompt-templates.js';

/**
 * REQ-010 S3: expand a leading `~` to the host home dir. An owner-configured `workspaceDir` of the
 * literal string `~/.aichat/...` was handed to opencode unexpanded, so opencode resolved it relative
 * to its own cwd → a junk `/workspace/~/.aichat/...` session directory. The shell never expands `~`
 * inside a program argument, so we expand it here, before the path leaves node.
 *  - `~`        → <homedir>
 *  - `~/foo`    → <homedir>/foo
 * Any other path (already absolute, or relative without a leading `~`) is returned unchanged.
 */
function expandTilde(p: string): string {
	if (p === '~') return homedir();
	if (p.startsWith('~/')) return join(homedir(), p.slice(2));
	return p;
}

/**
 * The per-turn chat-context bag every AgentDriver's `openSession` receives (a driver reads only the
 * keys it cares about). Named `ChatContext` (aichatoverview#165, formerly `OpencodeChatContext`) since
 * codex + cc share it too, and hoisted to `agent/` above the opencode dir.
 *
 * roomType: 1=GROUP, 2=FRIEND(1:1 DM); counterpartUid present for DMs (the other party).
 * isOwner: for DMs, whether the counterpart is the aiclaw's OWNER — read from the inbound
 *   WS message's `message.aiclaw.isOwner` (server fills it; present only on DM pushes).
 */
export interface ChatContext {
	roomType: number;
	// REQ-029 (#29): roomId/counterpartUid 为不透明字符串（防 >2^53 精度丢失）。
	roomId: string;
	counterpartUid?: string;
	isOwner?: boolean;
	/**
	 * REQ-009 #85: owner-configured absolute host path. When set (non-empty), it is the absolute
	 * override and wins for ANY context (in practice only groups carry it).
	 */
	workspaceDir?: string;
	/**
	 * REQ-009 #85: the group's human-readable group number ("groupkey"). Preferred over roomId as
	 * the default group workspace segment so the owner can cd into a stable, human-readable path.
	 */
	account?: string | number;
	/**
	 * REQ-018: LAZY resolver for this aiclaw's own display name (resolved once + cached at the handler).
	 * Now used by ALL FOUR drivers — the unified system-prompt identity anchor renders `{displayName}`
	 * from it (cc #132 was the original consumer; opencode/codex/openclaw joined in REQ-018). A driver
	 * only calls it when templates are present, so drivers/turns without templates still pay nothing.
	 * Kept a thunk (not an eager `selfName` field) so the cost is pay-per-use.
	 */
	getSelfName?: () => Promise<string | undefined>;
	/**
	 * REQ-018: owner-configured 人设 (publicPersona), cached at the handler. Rendered into the system
	 * layer's persona_section by each driver (non-blank only). NOT injected into the inbound envelope
	 * anymore (#188 → REQ-018: the persona block retired from the per-turn message).
	 */
	persona?: string | null;
	/**
	 * REQ-018: server-fetched agent prompt templates (identity anchor + persona section + reply
	 * contract). Present iff the supervisor fetched them fail-fast (buildAgent) / the handler prewarmed
	 * them (onConnected). When undefined the driver renders NO system prompt (degrades gracefully).
	 */
	templates?: AgentPromptTemplates;
}

/**
 * PURE — derive the per-conversation opencode workspace directory under `base`.
 *
 * REQ-008 #77 fix: ALWAYS namespaced by `aiclawUid` first so two opencode identities never
 * collide on the shared `owner` / `group` / `dm` sub-dirs. (Latent gap before this slice:
 * the layout had no per-identity segment, so e.g. two aiclaws both DMing their OWNER, or
 * both in the same group/roomId, would have shared one workspace dir.)
 *
 * REQ-009 #85: an owner-configured absolute `workspaceDir` overrides everything — when set it is
 * returned verbatim (NOT namespaced), so the owner can pin a group to a fixed host path. Otherwise
 * the default group segment prefers the human-readable groupkey (`account`) over `roomId`, so the
 * owner cd's into `<base>/<aiclawUid>/group/<account>` on the machine.
 *
 *  - owner workspaceDir set            → <workspaceDir>                 (absolute override, any ctx)
 *  - owner DM (roomType===2 && isOwner) → <base>/<aiclawUid>/owner      (the aiclaw's owner gets a stable alias)
 *  - friend DM (roomType===2)           → <base>/<aiclawUid>/dm/<counterpartUid>  (one dir per peer)
 *  - group (roomType===1)               → <base>/<aiclawUid>/group/<account ?? roomId>
 *  - unknown roomType                   → conservative group-by-(account ?? roomId) fallback
 *
 * owner vs friend is distinguished by `message.aiclaw.isOwner` on the inbound message
 * (server-computed senderUid==ownerUid; AiclawExt is present only on DM pushes).
 */
export function deriveWorkspaceDir(base: string, aiclawUid: string, ctx: ChatContext): string {
	// REQ-009 #85: owner's absolute override wins for any context (in practice only groups carry it).
	// REQ-010 S3: expand a leading `~` so a literal `~/.aichat/...` override resolves to the host home
	// dir (not opencode's cwd) → a real absolute path, never `/workspace/~/...`.
	if (ctx.workspaceDir && ctx.workspaceDir.trim() !== '') return expandTilde(ctx.workspaceDir.trim());
	// #77 fix: per-identity root segment — never let two aiclaws share a conversation dir.
	// Expand `~` in the base too, so a tilde-rooted base never leaks an unexpanded `~` into any segment.
	const root = join(expandTilde(base), String(aiclawUid));
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
		// REQ-009 #85: prefer the human-readable groupkey; fall back to roomId when account missing.
		return join(root, 'group', String(ctx.account ?? ctx.roomId));
	}
	// ponytail: unknown roomType → conservative group-by-(account ?? roomId) fallback (no new
	// abstraction, reuse the group layout) until a real new room type appears that needs its own handling.
	return join(root, 'group', String(ctx.account ?? ctx.roomId));
}
