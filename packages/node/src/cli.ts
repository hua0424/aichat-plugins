#!/usr/bin/env node
import { activate } from './commands/activate.js';
import { start } from './commands/start.js';
import { handleSendMessage } from './commands/send-message.js';
import { handleResetSession } from './commands/reset-session.js';
import { handleRecoverRun } from './commands/recover-run.js';
import { handleConfirmCcCwd } from './commands/confirm-cc-cwd.js';
import { handleConfirmCodexThread } from './commands/confirm-codex-thread.js';
import { handleReconcileCodexAgents } from './commands/reconcile-codex-agents.js';
import { handleMemberInfo } from './commands/member-info.js';
import { handleListFriends } from './commands/list-friends.js';
import { handleFindFriend } from './commands/find-friend.js';
import { handleListGroups } from './commands/list-groups.js';
import { handleListGroupMembers } from './commands/list-group-members.js';
import { handleGroupConfig } from './commands/group-config.js';
import { installSkill } from './capability/skill.js';

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
	case 'activate':
		await handleActivate(args.slice(1));
		break;
	case 'start':
		await start();
		break;
	// REQ-004 M3: CLI 扩展
	case 'send-message':
		await handleSendMessage(args.slice(1));
		break;
	// aichatoverview#124: runtime per-room agent session reset
	case 'reset-session':
		await handleResetSession(args.slice(1));
		break;
	case 'recover-run':
		await handleRecoverRun(args.slice(1));
		break;
	case 'confirm-cc-cwd':
		await handleConfirmCcCwd(args.slice(1));
		break;
	case 'confirm-codex-thread':
		await handleConfirmCodexThread(args.slice(1));
		break;
	case 'reconcile-codex-agents':
		await handleReconcileCodexAgents(args.slice(1));
		break;
	// REQ-010 S3: read-only query subcommands
	case 'member-info':
		await handleMemberInfo(args.slice(1));
		break;
	case 'list-friends':
		await handleListFriends(args.slice(1));
		break;
	case 'find-friend':
		await handleFindFriend(args.slice(1));
		break;
	// REQ-010 S4: group query subcommands
	case 'list-groups':
		await handleListGroups(args.slice(1));
		break;
	case 'list-group-members':
		await handleListGroupMembers(args.slice(1));
		break;
	case 'group-config':
		await handleGroupConfig(args.slice(1));
		break;
	case 'install-skill': {
		const written = installSkill();
		if (written.length > 0) {
			console.log(`Installed aichat-reply skill:\n  ${written.join('\n  ')}`);
		} else {
			console.error('Failed to install aichat-reply skill (no writable skill directory).');
			process.exit(1);
		}
		break;
	}
	default:
		printHelp();
		break;
}

async function handleActivate(args: string[]): Promise<void> {
	let token = '';

	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--token' && args[i + 1]) {
			token = args[++i];
		}
	}

	if (!token) {
		console.error('Usage: aichat activate --token <activation-token>');
		process.exit(1);
	}

	await activate(token);
}

function printHelp(): void {
	console.log(`
aichat - HuLa AI Assistant Plugin

Commands:
  activate --token <token>                       Activate with server token
  start                                          Connect and run
  send-message --content <text> [--request-id <id>] Reply to the current chat
                                                 (room + identity are bound automatically
                                                  from your agent session — never passed in;
                                                  unknown: retain ID + content, do not change ID;
                                                  no automatic replay beyond 7 days)
  reset-session [--request-id <id>]              Reset this room's agent session (fresh next msg)
  recover-run <runId> --verified-stopped          Offline-only: confirm a manually verified stopped run
                                                 (stop daemon first; NEVER assume restart proves stopped)
  confirm-cc-cwd <uid> <room> <sessionId> <generation> <ORIGINAL-absolute-cwd> <owner-approval.json>
                                                 Offline ONLY (not an agent capability): stop daemon, back up
                                                 conversations.json, independently verify product-owner identity,
                                                 immutable approval artifact/reference and ORIGINAL cwd + exact
                                                 uid/room/sessionId/generation; preserve artifact SHA-256.
                                                 If config cwd differs, owner corrects config BEFORE restart.
                                                 Run offline command, then restart. This is manual trust, NOT
                                                 cryptographic server authentication; never guess from config.
                                                 Approval JSON: {"owner":"...","approvalRef":"https://...",
                                                 "uid":"...","room":"...","sessionId":"...",
                                                 "generation":1,"originalCwd":"/absolute/path",
                                                 "approvedOriginalCwd":true}. Conflict: reset-session fresh instead.
  confirm-codex-thread <uid> <room> <threadId> <generation> <ORIGINAL-absolute-cwd> <owner-approval-with-original-prompt.json>
                                                 Offline ONLY; stop daemon, independently verify owner HTTPS
                                                 approval and exact original cwd/prompt. JSON binds uid, room,
                                                 threadId, generation, originalCwd, originalPrompt,
                                                 originalPromptSha256, approvedOriginalThread:true,
                                                 owner, approvalRef. The CLI cannot authenticate the owner.
  reconcile-codex-agents <uid> <room> <generation> <controlled-root> <absolute-AGENTS.md> <replacement-prompt-file|remove> <owner-approval.json>
                                                 Offline ONLY: owner-approved controlled test directory with no other file writers.
                                                  Full backup and pre-rename original hash/inode check. Artifact binds
                                                  uid/room/generation/root/file, owner HTTPS reference, originalFileSha256,
                                                  originalBlockSha256, operation, optional replacementPromptSha256,
                                                  approvedControlledTestDirectory:true, approvedOwnedBlock:true,
                                                  approvedExclusiveTestWindow:true.
                                                  A pre-check cannot exclude a non-cooperating writer in rename window.
  member-info <uid>                              Look up a user's public profile
  list-friends                                   List this assistant's friends
  find-friend <keyword>                          Search users by keyword (substring match)
  list-groups                                    List the groups this assistant has joined
  list-group-members [--online] [--groupid <id>] List a group's members with online status
                                                  (send/query/reset accept --json for {ok,result} or
                                                   {ok:false,code,message,retryable}; legacy group
                                                   result.error exits 0, --json errors exit nonzero)
                                                 (default: the current chat's group;
                                                  --groupid <id> targets a different joined group,
                                                  where <id> is the 'id' from list-groups output;
                                                  --online shows only online members)
  install-skill                                  Install the aichat-reply opencode skill
  group-config --room <roomId>                   Query group config
  group-config --room <roomId> [options...]      Update group config

Examples:
  aichat activate --token eyJ...
  aichat start
  aichat send-message --content "Hello"
  aichat member-info 12345
  aichat list-friends
  aichat find-friend "alice"
  aichat list-groups
  aichat list-group-members --online
  aichat list-group-members --groupid 12345
  aichat install-skill
  aichat group-config --room 12345 --rate-limit 20 --respond-to-ai true
`);
}
