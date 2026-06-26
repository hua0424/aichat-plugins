import type { HulaApiClient } from '../api/hula-api.js';

/**
 * REQ-010 S1 — capability execution context.
 *
 * The identity (`aiclawUid`) and target `roomId` are RESOLVED by node from the agent's session
 * (never from the CLI / capability args), and the per-identity `apiClient` is the only way a
 * capability can reach HuLa-Server. Capabilities read room/identity from HERE, never from args —
 * this is the anti-spoofing seam.
 */
export interface CapabilityContext {
	aiclawUid: number;
	roomId: number;
	apiClient: HulaApiClient;
}

/** A node-local capability: pure-ish, gets a bound context + opaque args, returns a JSON result. */
export type Capability = (ctx: CapabilityContext, args: Record<string, unknown>) => Promise<unknown>;

/** A tiny name → Capability registry. */
export class CapabilityRegistry {
	private readonly caps = new Map<string, Capability>();

	register(name: string, cap: Capability): void {
		this.caps.set(name, cap);
	}

	has(name: string): boolean {
		return this.caps.has(name);
	}

	async invoke(name: string, ctx: CapabilityContext, args: Record<string, unknown>): Promise<unknown> {
		const cap = this.caps.get(name);
		if (!cap) throw new Error(`unknown capability: ${name}`);
		return cap(ctx, args);
	}
}

/**
 * REQ-010 S1 — the `send-message` capability: reply into the chat bound to ctx.
 *
 * Reads only `args.content` (a non-empty string, trimmed). The room/identity come from ctx ONLY —
 * any `args.room` / identity field is IGNORED (anti-spoofing). Throws on missing/empty content.
 */
export function sendMessageCapability(): Capability {
	return async (ctx, args) => {
		const raw = args.content;
		if (typeof raw !== 'string' || raw.trim().length === 0) {
			throw new Error('send-message: `content` is required and must be a non-empty string');
		}
		const content = raw.trim();
		const { msgId } = await ctx.apiClient.sendMessage(ctx.roomId, content);
		return { msgId, roomId: ctx.roomId };
	};
}
