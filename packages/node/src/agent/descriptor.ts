import type { AgentEntry } from '../registry.js';
import type { RunDriver } from './events.js';

/** Static, locally installed adapter contract; no discovery or credential loading in the CLI. */
export const DRIVER_CONTRACT_VERSION = 1;
export interface DriverDescriptor {
	readonly contractVersion: number;
	readonly type: string;
	readonly workspaceBase?: string;
	readonly create: (entry: AgentEntry) => RunDriver;
}

/** An invalid adapter only degrades its own identity when the supervisor calls buildDriver. */
export function createDriver(entry: AgentEntry, descriptors: ReadonlyMap<string, DriverDescriptor>): RunDriver {
	const descriptor = descriptors.get(entry.tool);
	if (!descriptor) throw new Error(`unsupported agent tool: ${entry.tool}`);
	if (!/^[a-z][a-z0-9-]{0,63}$/.test(entry.tool) ||
		descriptor.contractVersion !== DRIVER_CONTRACT_VERSION || descriptor.type !== entry.tool)
		throw new Error(`unsupported driver contract: ${entry.tool} v${descriptor.contractVersion}`);
	const driver = descriptor.create(entry);
	if (driver.type !== descriptor.type) throw new Error(`driver type mismatch: ${entry.tool}`);
	return driver;
}
