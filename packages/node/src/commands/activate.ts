import { existsSync, mkdirSync } from 'node:fs';
import { AICHAT_HOME, loadConfig, getServerUrl } from '../config.js';
import { resolveAgentCredential } from '../registry.js';
import { getMachineCode } from '../auth/machine.js';

/**
 * aichat activate --token <activation-token>
 *
 * Delegates to registry.resolveAgentCredential (the single credential path shared with `aichat start`):
 * cache-hit → reuse (IDEMPOTENT — re-running the same token never re-activates, so a live identity is
 * never bricked); cache-miss → POST server /im/aiclaw/anyTenant/activate once and write the per-token
 * cache under ~/.aichat/credentials/. The server activate contract is unchanged.
 */
export async function activate(activationToken: string): Promise<void> {
	if (!existsSync(AICHAT_HOME)) {
		mkdirSync(AICHAT_HOME, { recursive: true });
	}

	const config = loadConfig();
	// server 地址：config.jsonc > 默认值，WS 地址转为 HTTP（与 start.ts 同源）
	const httpBase = getServerUrl(config)
		.replace('ws://', 'http://')
		.replace('wss://', 'https://')
		.replace(/\/ws\/ws$/, '');

	console.log(`[activate] Server: ${httpBase}`);
	console.log(`[activate] Activating...`);

	try {
		const cred = await resolveAgentCredential(
			{ tool: 'openclaw', token: activationToken },
			{ machineCode: getMachineCode(), httpBase },
		);
		console.log(`\n✓ Activated (per-token credential cached).`);
		console.log(`  UID: ${cred.uid}`);
		console.log(`  Add this token to the "agents" registry in ~/.aichat/config.jsonc, then run 'aichat start'.\n`);
	} catch (err) {
		console.error(`[activate] Failed: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
}
