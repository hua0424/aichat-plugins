import { runCapabilityCommand } from './capability-command.js';

/** uid is a query target, never the acting identity. */
export async function handleMemberInfo(args: string[]): Promise<void> {
	return runCapabilityCommand('member-info', args, JSON.stringify);
}
