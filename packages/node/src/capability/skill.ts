import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * REQ-010 S1 — install the `aichat-reply` opencode skill.
 *
 * Teaches the agent that to reply to the current chat it runs
 * `aichat send-message --content "<reply>"` — and that the room/identity are bound automatically
 * (it must NEVER pass room or identity), and to call it ONLY when it actually wants to reply.
 *
 * opencode 1.17.9 discovers GLOBAL skills under (verified via opencode.ai/docs/skills):
 *   - ~/.config/opencode/skills/<name>/SKILL.md   (canonical opencode global)
 *   - ~/.claude/skills/<name>/SKILL.md            (Claude-compatible)
 *   - ~/.agents/skills/<name>/SKILL.md            (agent-compatible)
 * SKILL.md must be all-caps; frontmatter must include `name` + `description`; names must be
 * UNIQUE across all locations. We write the SAME skill (same name) into all three so discovery is
 * guaranteed regardless of which loader an opencode build prefers — opencode de-dups by name, so
 * the duplicate paths are harmless, not a name collision.
 */

const SKILL_NAME = 'aichat-reply';

const QUERY_SKILL_NAME = 'aichat-query';

const SKILL_MD = `---
name: ${SKILL_NAME}
description: Reply to the current HuLa chat conversation. Use ONLY when you actually want to send a reply to the user you are talking to.
license: MIT
compatibility: opencode
---

## What I do

I let you send a reply into the current chat conversation.

## How to reply

Run this in bash, with your user-facing reply as the content:

\`\`\`bash
aichat send-message --content "<your reply to the user>"
\`\`\`

## Important

- The room and your identity are bound AUTOMATICALLY by the system from your current session.
  NEVER pass a room, recipient, identity, or any "--room"/"--to" argument — there is none.
- Your normal text output is treated as private thinking/analysis and is NOT shown to the user.
  The ONLY way to send something to the user is to run \`aichat send-message\`.
- Only run this when you genuinely want to reply. If no reply is warranted (pure pleasantries,
  nothing to add), simply do not run it — the turn ends and nothing is sent.
`;

const QUERY_SKILL_MD = `---
name: ${QUERY_SKILL_NAME}
description: Look up users and groups this assistant can see — member profiles, friends, user search, the assistant's groups, and a group's members with online status.
license: MIT
compatibility: opencode
---

## What I do

I let you look up users and groups that this assistant can see — so you can decide who to talk to,
who to add, and which group members are online.

## Read capabilities

- \`aichat member-info <uid>\` — look up any user's public profile.
- \`aichat list-friends\` — list this assistant's friends.
- \`aichat find-friend <keyword>\` — search users by keyword (to find people to add).
- \`aichat list-groups\` — list the groups this assistant is in; each result has an \`id\`, a \`name\`,
  and member/online counts.
- \`aichat list-group-members [--online] [--groupid <id>]\` — list a group's members with online
  status. Default = the current chat's group. To query a DIFFERENT group you've joined, pass
  \`--groupid <id>\` using the **\`id\`** field from \`list-groups\` output (NOT the name or account).
  \`--online\` keeps only online members.

## Important

- Your identity and the current room are bound AUTOMATICALLY from your session — never pass any
  identity or room argument. The ONLY arguments are the query targets themselves: \`<uid>\`,
  \`<keyword>\`, and \`--groupid <id>\`.
`;

/** The skills installSkill writes — each into every skill root. */
const SKILLS: Array<{ name: string; md: string }> = [
	{ name: SKILL_NAME, md: SKILL_MD },
	{ name: QUERY_SKILL_NAME, md: QUERY_SKILL_MD },
];

/** Global skill roots opencode 1.17.9 discovers. */
function skillRoots(): string[] {
	const home = homedir();
	return [
		join(home, '.config', 'opencode', 'skills'),
		join(home, '.claude', 'skills'),
		join(home, '.agents', 'skills'),
	];
}

/**
 * Idempotently (overwrite) write every skill into every global skill root. Best-effort: a write
 * that throws is skipped (never crashes node). Returns the list of paths actually written.
 */
export function installSkill(): string[] {
	const written: string[] = [];
	for (const root of skillRoots()) {
		for (const skill of SKILLS) {
			const dir = join(root, skill.name);
			const file = join(dir, 'SKILL.md');
			try {
				mkdirSync(dir, { recursive: true });
				writeFileSync(file, skill.md, 'utf-8');
				written.push(file);
			} catch {
				/* best-effort: skip a skill/root we can't write */
			}
		}
	}
	return written;
}
