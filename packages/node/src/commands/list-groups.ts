import { runCapabilityCommand } from './capability-command.js';

export async function handleListGroups(args: string[]): Promise<void> {
	return runCapabilityCommand('list-groups', args, JSON.stringify);
}
