import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AICHAT_HOME } from '../../config.js';

/**
 * REQ-011 S3 (AC5/AC9) — the per-room CC transcript.
 *
 * The headless CC turn runs UNATTENDED (no owner watching a TUI), so the transcript REPLACES the owner
 * watching the terminal: it must capture CC's FULL session — the inbound (attributed) message AND CC's
 * OUTPUT (assistant text / tool_use / thinking) — not just the inbound line. It is an append-only JSONL
 * file per (aiclawUid, roomId), persisted under a persistent volume so it survives turn/restart.
 *
 * The OUTPUT records are a RAW TEE of the stdout the driver already reads for control-plane. This does
 * NOT violate "stdout = control-plane only": that rule means don't PARSE stdout to drive the panel/reply
 * (those still come from CC's hooks / the `aichat send-message` CLI). The transcript is a passive tee for
 * the owner's benefit — never fed back into the reply/thinking path.
 */

/** One JSONL transcript line. `text` for inbound/assistant/thinking; `tool` for tool_use. */
export interface CcTranscriptRecord {
	/** epoch ms when the record was teed. */
	ts: number;
	/** claude `session_id` this turn ran under (undefined on a fresh turn before system/init). */
	session_id?: string;
	kind: 'inbound' | 'assistant' | 'tool_use' | 'thinking';
	/** inbound/assistant/thinking payload text. */
	text?: string;
	/** tool_use tool name. */
	tool?: string;
	/** truncated JSON of the tool_use input. */
	tool_input?: string;
}

/**
 * Append-only per-room transcript sink. Injectable so the driver takes it as a dep (a fake in tests).
 * `key` is the CC binding string `aiclaw-{uid}-room-{roomId}` (also the file stem).
 */
export interface CcTranscriptWriter {
	append(key: string, record: CcTranscriptRecord): void;
}

/** Default location: persists under ~/.aichat/cc/transcripts (a persistent volume). */
export const DEFAULT_CC_TRANSCRIPTS_DIR = join(AICHAT_HOME, 'cc', 'transcripts');

/**
 * File-backed CcTranscriptWriter: one append-only `<binding>.jsonl` per room. Each `append` mkdir -p's
 * the dir and appends a single JSON line. Write failures degrade to a no-op (a transcript hiccup must
 * never crash a turn) rather than throwing.
 */
export class FileCcTranscriptWriter implements CcTranscriptWriter {
	constructor(private readonly dir: string = DEFAULT_CC_TRANSCRIPTS_DIR) {}

	append(key: string, record: CcTranscriptRecord): void {
		try {
			mkdirSync(this.dir, { recursive: true });
			appendFileSync(join(this.dir, `${key}.jsonl`), `${JSON.stringify(record)}\n`, 'utf-8');
		} catch {
			/* best-effort: a transcript write failure must never break the turn */
		}
	}
}
