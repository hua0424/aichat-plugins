#!/usr/bin/env node
import { activate } from './commands/activate.js';
import { start } from './commands/start.js';
import { handleSendMessage } from './commands/send-message.js';
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
  install-skill                                  Install the aichat-reply opencode skill
  group-config --room <roomId>                   Query group config
  group-config --room <roomId> [options...]      Update group config

Examples:
  aichat activate --backend openclaw --token eyJ...
  aichat start
  aichat send-message --content "Hello"
  aichat install-skill
  aichat group-config --room 12345 --rate-limit 20 --respond-to-ai true
`);
}
