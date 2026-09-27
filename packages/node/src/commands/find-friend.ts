import { runCapabilityCommand } from './capability-command.js';

/** keyword is a query target, never the acting identity. */
export async function handleFindFriend(args: string[]): Promise<void> {
	return runCapabilityCommand('find-friend', args, JSON.stringify);
}
