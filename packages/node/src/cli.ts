#!/usr/bin/env node
import { activate } from './commands/activate.js';
import { start } from './commands/start.js';
import { handleSendMessage } from './commands/send-message.js';
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
	let backend = '';
	let token = '';

	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--backend' && args[i + 1]) {
			backend = args[++i];
		} else if (args[i] === '--token' && args[i + 1]) {
			token = args[++i];
		}
	}

	if (!token) {
		console.error('Usage: aichat activate --backend openclaw --token <activation-token>');
		process.exit(1);
	}

	await activate(token, backend || 'openclaw');
}

function printHelp(): void {
	console.log(`
aichat - HuLa AI Assistant Plugin

Commands:
  activate --backend <backend> --token <token>   Activate with server token
  start                                          Connect and run
  send-message --content <text>                  Reply to the current chat
                                                 (room + identity are bound automatically
                                                  from your agent session — never passed in)
  member-info <uid>                              Look up a user's public profile
  list-friends                                   List this assistant's friends
  find-friend <keyword>                          Search users by keyword (substring match)
  list-groups                                    List the groups this assistant has joined
  list-group-members [--online] [--groupid <id>] List a group's members with online status
                                                 (default: the current chat's group;
                                                  --groupid targets a different joined group;
                                                  --online shows only online members)
  install-skill                                  Install the aichat-reply opencode skill
  group-config --room <roomId>                   Query group config
  group-config --room <roomId> [options...]      Update group config

Examples:
  aichat activate --backend openclaw --token eyJ...
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
