import { runCapabilityCommand } from './capability-command.js';

/** The optional groupid is a query target; the core-owned default room is never reassigned. */
export async function handleListGroupMembers(args: string[]): Promise<void> {
	// Legacy stdout contains result.error and exits 0 for group business errors; --json is strict.
	return runCapabilityCommand('list-group-members', args, (result) => {
		if (result && typeof result.error === 'string') return JSON.stringify({ roomId: result.roomId, error: result.error });
		return JSON.stringify(result);
	});
}
