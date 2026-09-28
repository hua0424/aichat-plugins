import type { AgentEntry } from '../registry.js';
import { contextDescriptors } from '../capability/context-descriptors.js';
import type { RunDriver } from './events.js';

/** Static, locally installed adapter contract; no discovery or credential loading in the CLI. */
export const DRIVER_CONTRACT_VERSION = 1;
export interface DriverDescriptor {
	readonly contractVersion: number;
	readonly type: string;
	readonly workspaceBase?: string;
	readonly context: { readonly kind: 'bound-channel' } | { readonly kind: 'native-env'; readonly env: string };
	readonly features: RunDriver['features'];
	readonly create: (entry: AgentEntry) => RunDriver;
}

/** Same lightweight native transport table is read by the CLI; no SDK or identity credential is loaded there. */
export function nativeContext(provider: string): DriverDescriptor['context'] {
	const descriptor = contextDescriptors.find((entry) => entry.provider === provider);
	if (!descriptor) throw new Error(`native context transport not registered: ${provider}`);
	return { kind: 'native-env', env: descriptor.env };
}

/** An invalid adapter only degrades its own identity when the supervisor calls buildDriver. */
export function createDriver(entry: AgentEntry, descriptors: ReadonlyMap<string, DriverDescriptor>): RunDriver {
	const descriptor = descriptors.get(entry.tool);
	if (!descriptor) throw new Error(`unsupported agent tool: ${entry.tool}`);
	if (!/^[a-z][a-z0-9-]{0,63}$/.test(entry.tool) ||
		descriptor.contractVersion !== DRIVER_CONTRACT_VERSION || descriptor.type !== entry.tool)
		throw new Error(`unsupported driver contract: ${entry.tool} v${descriptor.contractVersion}`);
	const transport = descriptor.context;
	if (transport.kind === 'native-env' &&
		!contextDescriptors.some((context) => context.provider === entry.tool && context.env === transport.env))
		throw new Error(`native context transport not registered: ${entry.tool}`);
	const driver = descriptor.create(entry);
	if (driver.type !== descriptor.type ||
		(['cancel', 'reset', 'promptUpdate'] as const).some((key) => driver.features[key] !== descriptor.features[key]))
		throw new Error(`driver contract mismatch: ${entry.tool}`);
	return driver;
}
