import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * REQ-018 — pure + small IO helpers for the AGENTS.md marked block (codex/openclaw shared).
 *
 * codex exec re-reads the workspace `AGENTS.md` each turn; openclaw reads a file in its workspace
 * (convention `~/.openclaw/AGENTS.md`, adapter_config-configurable in the future — see the openclaw
 * driver's R1 confirmation note). Both drivers render the SAME unified system prompt (identity anchor +
 * persona + reply contract) into this marked block:
 *
 *   <!-- aichat:system:begin -->
 *   <rendered system prompt>
 *   <!-- aichat:system:end -->
 *
 * The markers make upsert idempotent AND shared across drivers: an older block (from the other driver
 * or an older template version) is replaced in place, never duplicated. `syncAgentsMdFile` hash-compares
 * before writing so an unchanged file costs zero IO (codex re-reads per turn).
 */

/** Begin marker of the aichat-managed block in AGENTS.md. */
export const AICHAT_SYSTEM_BEGIN = '<!-- aichat:system:begin -->';
/** End marker of the aichat-managed block in AGENTS.md. */
export const AICHAT_SYSTEM_END = '<!-- aichat:system:end -->';

const BLOCK_RE = /<!-- aichat:system:begin -->[\s\S]*?<!-- aichat:system:end -->/;

/** Wrap content in the marked block (markers + newlines). */
export function renderSystemBlock(content: string): string {
	return `${AICHAT_SYSTEM_BEGIN}\n${content}\n${AICHAT_SYSTEM_END}`;
}

/** Pure: upsert the aichat system block into existing AGENTS.md content. */
export function upsertSystemBlock(existing: string, content: string): string {
	const block = renderSystemBlock(content);
	if (BLOCK_RE.test(existing)) return existing.replace(BLOCK_RE, block);
	const trimmed = existing.trimEnd();
	return trimmed === '' ? `${block}\n` : `${trimmed}\n\n${block}\n`;
}

/** Pure hash-compare: true when a write would change the file (drivers skip the write when false). */
export function needsSystemBlockUpdate(existing: string, content: string): boolean {
	return upsertSystemBlock(existing, content) !== existing;
}

/** IO: read + upsert + write-if-changed. Returns true when a write happened. Missing file → treat as ''. */
export async function syncAgentsMdFile(filePath: string, content: string): Promise<boolean> {
	let existing = '';
	try {
		existing = await readFile(filePath, 'utf-8');
	} catch {
		/* missing → '' */
	}
	const next = upsertSystemBlock(existing, content);
	if (next === existing) return false; // zero IO
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, next, 'utf-8');
	return true;
}
