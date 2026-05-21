#!/usr/bin/env node
import { activate } from './commands/activate.js';
import { start } from './commands/start.js';
import { handleSendMessage } from './commands/send-message.js';
import { handleGroupConfig } from './commands/group-config.js';

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
  send-message --room <roomId> --content <text>  Send a message to a room
  send-message --to <uid> --content <text>       Send a message to a friend
  group-config --room <roomId>                   Query group config
  group-config --room <roomId> [options...]      Update group config

Examples:
  aichat activate --backend openclaw --token eyJ...
  aichat start
  aichat send-message --room 12345 --content "Hello"
  aichat group-config --room 12345 --rate-limit 20 --respond-to-ai true
`);
}
