import { appendFile, mkdir } from 'node:fs/promises';
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
 * File-backed CcTranscriptWriter: one append-only `<binding>.jsonl` per room.
 *
 * aichatoverview#166: the transcript is written on EVERY streamed CC event (3+/turn), so the writes are
 * moved OFF the shared event loop — mkdir once (memoized), and each `append` chains an async `appendFile`
 * PER KEY (a per-file promise chain preserves line order without a sync write). Write failures degrade to
 * a no-op (a transcript hiccup must never crash a turn) rather than throwing.
 */
export class FileCcTranscriptWriter implements CcTranscriptWriter {
	private dirEnsured = false;
	/** Per-key append chain: serializes appends to the SAME file so line order is preserved. */
	private readonly chains = new Map<string, Promise<void>>();

	constructor(private readonly dir: string = DEFAULT_CC_TRANSCRIPTS_DIR) {}

	append(key: string, record: CcTranscriptRecord): void {
		const line = `${JSON.stringify(record)}\n`;
		const prev = this.chains.get(key) ?? Promise.resolve();
		this.chains.set(
			key,
			prev.then(() => this.flush(key, line)).catch(() => {}),
		);
	}

	/** Resolve when all queued appends across every key have drained (tests / graceful shutdown). */
	whenWritten(): Promise<void> {
		return Promise.all(this.chains.values()).then(() => {});
	}

	private async flush(key: string, line: string): Promise<void> {
		try {
			if (!this.dirEnsured) {
				await mkdir(this.dir, { recursive: true });
				this.dirEnsured = true;
			}
			await appendFile(join(this.dir, `${key}.jsonl`), line, 'utf-8');
		} catch {
			/* best-effort: a transcript write failure must never break the turn */
		}
	}
}
