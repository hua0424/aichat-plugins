import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * REQ-018 — pure + small IO helpers for the AGENTS.md marked block.
 *
 * Openclaw reads a file in its workspace (convention `~/.openclaw/AGENTS.md`,
 * adapter_config-configurable in the future — see the openclaw driver's R1 confirmation note).
 * The legacy Codex driver wrote the same block; native Codex runs now inspect it for
 * conflicts but pass the prepared prompt via per-run client configuration instead:
 *
 *   <!-- aichat:system:begin -->
 *   <rendered system prompt>
 *   <!-- aichat:system:end -->
 *
 * The markers make openclaw's upsert idempotent. An older block is replaced in place,
 * never duplicated. `syncAgentsMdFile` skips unchanged writes.
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
