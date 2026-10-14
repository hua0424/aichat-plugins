import { digestId } from './run-bind.js';

/**
 * #405 — per-run native ancestor ledger for OpenCode.
 *
 * The driver observes the in-order SSE bus and records ground truth:
 * user message id → assistant message ids (via `parentID`) → tool call ids
 * (via ToolPart `messageID` + `callID`). At prompt completion the ledger renders
 * one of three verdicts:
 *
 * - verified: exactly one fresh user message, every observed tool call resolves
 *   through a known assistant to that user, and the prompt response's parentID
 *   matches it. Only then may a report claim a proven native chain.
 * - conflict: two fresh user messages, a tool callID reused across messages, a
 *   tool/assistant resolving to a foreign (unobserved-user) ancestor, or the
 *   completion parent disagreeing with the observed user. The caller must fail
 *   the turn loudly — never attribute to current/latest.
 * - unverified: proof is MISSING (no user message observed, a tool's message
 *   never announced, completion parent unrecorded). The caller keeps the
 *   declared legacy-unknown posture: the env-carried binding still routes the
 *   send exactly, but nothing claims a proven chain.
 *
 * Messages created before the run started (history replay on a resumed session,
 * compaction echoes) are ignored so old turns can never poison a new ledger.
 * Raw ids never leave this module except into the desensitized `record()`.
 */

export interface ObservedMessage {
	id?: unknown;
	role?: unknown;
	parentID?: unknown;
	sessionID?: unknown;
	timeCreated?: unknown;
}

export interface ObservedToolPart {
	callID?: unknown;
	messageID?: unknown;
}

export interface CompletionInfo {
	id?: unknown;
	parentID?: unknown;
}

export type AncestorVerdict =
	| { ok: true; userMessageID: string }
	| { ok: false; reason: 'conflict' | 'unverified'; detail: string };

export interface AncestorRecord {
	user?: string;
	assistants: number;
	toolCalls: number;
	verified: boolean;
	conflict?: string;
}

const str = (v: unknown): string | undefined => typeof v === 'string' && v.length > 0 ? v : undefined;
const num = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) ? v : undefined;

export class AncestorChain {
	private userMessageID?: string;
	private readonly assistants = new Map<string, string | undefined>();
	private readonly toolCalls = new Map<string, string>();
	private conflictDetail?: string;
	constructor(private readonly startedAt: number = Date.now()) {}

	private fail(detail: string): void {
		if (!this.conflictDetail) this.conflictDetail = detail;
	}

	observeMessageUpdated(info: ObservedMessage): void {
		const id = str(info.id);
		if (!id) return;
	 const created = num(info.timeCreated);
		if (created !== undefined && created < this.startedAt) return; // stale replay, not this turn
		if (info.role === 'user') {
			if (this.userMessageID === undefined) this.userMessageID = id;
			else if (this.userMessageID !== id) this.fail(`multiple-user-messages:${digestId(this.userMessageID)}+${digestId(id)}`);
		} else if (info.role === 'assistant') {
			const parent = str(info.parentID);
			const known = this.assistants.get(id);
			if (known === undefined && !this.assistants.has(id)) this.assistants.set(id, parent);
			else if (known !== parent) this.fail(`assistant-parent-changed:${digestId(id)}`);
		}
	}

	observeToolPart(part: ObservedToolPart): void {
		const call = str(part.callID);
		const message = str(part.messageID);
		if (!call || !message) return;
		const known = this.toolCalls.get(call);
		if (known === undefined) this.toolCalls.set(call, message);
		else if (known !== message) this.fail(`callID-reused:${digestId(call)}`);
	}

	verifyCompletion(info: CompletionInfo): AncestorVerdict {
		if (this.conflictDetail) return { ok: false, reason: 'conflict', detail: this.conflictDetail };
	 const responseParent = str(info.parentID);
		if (this.userMessageID === undefined)
			return { ok: false, reason: 'unverified', detail: 'no-user-message-observed' };
		if (responseParent === undefined)
			return { ok: false, reason: 'unverified', detail: 'completion-parent-unrecorded' };
		if (responseParent !== this.userMessageID)
			return { ok: false, reason: 'conflict', detail: `completion-parent-mismatch:${digestId(responseParent)}` };
		for (const [call, message] of this.toolCalls) {
			const parent = this.assistants.get(message);
			if (parent === undefined)
				return { ok: false, reason: 'unverified', detail: `tool-ancestor-unannounced:${digestId(call)}` };
			if (parent !== this.userMessageID)
				return { ok: false, reason: 'conflict', detail: `tool-foreign-ancestor:${digestId(call)}` };
		}
		return { ok: true, userMessageID: this.userMessageID };
	}

	/** Desensitized counts + digests only — safe for recovery records, logs and issue reports. */
	record(verified: boolean): AncestorRecord {
		return {
			...(this.userMessageID === undefined ? {} : { user: digestId(this.userMessageID) }),
			assistants: this.assistants.size,
			toolCalls: this.toolCalls.size,
			verified,
			...(this.conflictDetail === undefined ? {} : { conflict: this.conflictDetail }),
		};
	}
}
