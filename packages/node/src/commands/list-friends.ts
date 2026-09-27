import { runCapabilityCommand } from './capability-command.js';

export async function handleListFriends(args: string[]): Promise<void> {
	return runCapabilityCommand('list-friends', args, JSON.stringify);
}
