#!/usr/bin/env node
import { activate } from './commands/activate.js';
import { start } from './commands/start.js';

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
	case 'activate':
		await handleActivate(args.slice(1));
		break;
	case 'start':
		await start();
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

Examples:
  aichat activate --backend openclaw --token eyJ...
  aichat start
`);
}
