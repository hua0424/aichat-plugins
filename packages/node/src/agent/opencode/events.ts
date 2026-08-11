import type { AgentEvent } from '../events.js';

/**
 * REQ-008 #77 — pure opencode-event → AgentEvent mapping.
 *
 * Translates the opencode SDK SSE event vocabulary (@opencode-ai/sdk@1.17.9) into
 * the driver-agnostic AgentEvent stream the MessageHandler consumes. PURE: no clock,
 * no I/O, one event in → at most one AgentEvent out (or null to ignore).
 *
 * NOT this function's job: tool start/end de-dup by callID (it is stateless per event,
 * so it emits a tool event per state-status; the SESSION layer collapses duplicates),
 * and the real `durationMs` for `done` (the session fills it — here it is 0).
 *
 * Always filtered by the caller's `sessionID`: an event for a different session
 * (or a session.idle/error for another id) → null, so a shared per-directory
 * subscription never leaks another session's events into this turn.
 *
 * `assistantMessageIDs`: opencode parts carry NO role — only sessionID/messageID — and
 * opencode also emits a `text` part for the USER message (the prompt we sent, reply
 * instruction envelope included). The CALLER whitelists message ids whose `message.updated`
 * event reported `role: 'assistant'` (opencode emits message.updated before that message's
 * parts on the same in-order SSE bus) and passes the set in; text/reasoning parts whose
 * messageID is not whitelisted are dropped so the user prompt never leaks into thinking.
 * Tool parts are not gated (user messages never carry tool parts).
 */
export function mapOpencodeEvent(
	evt: unknown,
	sessionID: string,
	assistantMessageIDs: ReadonlySet<string>,
): AgentEvent | null {
	if (!evt || typeof evt !== 'object') return null;
	const e = evt as { type?: unknown; properties?: unknown };
	if (typeof e.type !== 'string') return null;
	const props = (e.properties ?? {}) as Record<string, unknown>;

	switch (e.type) {
		case 'message.part.updated': {
			const part = props.part as
				| {
						type?: string;
						sessionID?: string;
						messageID?: string;
						text?: string;
						tool?: string;
						state?: { status?: string; input?: Record<string, unknown> };
				  }
				| undefined;
			if (!part || part.sessionID !== sessionID) return null;
			const delta = typeof props.delta === 'string' ? props.delta : undefined;

			if (part.type === 'text' || part.type === 'reasoning') {
				// Parts carry no role; only assistant-whitelisted messages may stream thinking,
				// otherwise the USER prompt (a text part too) would leak into thinking.
				if (typeof part.messageID !== 'string' || !assistantMessageIDs.has(part.messageID)) return null;
				// prefer the streaming delta; fall back to the accumulated part text.
				const text = delta ?? (typeof part.text === 'string' ? part.text : '');
				return { type: 'thinking', text };
			}
			if (part.type === 'tool') {
				const status = part.state?.status;

				// REQ-010 S1: the terminal-tool reply path is retired. There is no longer any
				// hula_send_message / hula_skip_reply detection here — the agent replies
				// out-of-band by running `aichat send-message` (the loopback capability), so
				// every tool maps generically: running/pending → start, completed/error → end.
				let phase: 'start' | 'end';
				if (status === 'running' || status === 'pending') phase = 'start';
				else if (status === 'completed' || status === 'error') phase = 'end';
				else return null; // unknown tool status → ignore
				return { type: 'tool', name: part.tool ?? 'unknown', phase };
			}
			// step-start / step-finish / snapshot / patch / agent / file / ... → ignore
			return null;
		}

		case 'session.idle': {
			if (props.sessionID !== sessionID) return null;
			// session fills the real durationMs; here it is a placeholder.
			return { type: 'done', durationMs: 0 };
		}

		case 'session.error': {
			// sessionID may be absent on session.error; only filter it out when it is
			// present AND points at a different session.
			if (typeof props.sessionID === 'string' && props.sessionID !== sessionID) return null;
			return { type: 'error', message: stringifyError(props.error) };
		}

		case 'session.status': {
			// aichatoverview#256 — serve reports provider rate-limit/backoff as
			// `{type:"retry", attempt, message, next}` (reason field present on some versions).
			// Map it to a TERMINAL error carrying the serve reason instead of letting the turn
			// ride the handler's 300s timeout into a generic thinking_session_timeout — backoffs
			// are hours long (free-tier limit), so waiting is pointless. busy = still working
			// (ignore); idle is already handled by session.idle.
			if (props.sessionID !== sessionID) return null;
			const status = props.status as
				| { type?: string; message?: string; reason?: string }
				| undefined;
			if (status?.type !== 'retry') return null;
			const text = typeof status.message === 'string' && status.message.length > 0 ? status.message : 'rate limited';
			const reason = typeof status.reason === 'string' && status.reason.length > 0 ? ` (${status.reason})` : '';
			return { type: 'error', message: `opencode retry: ${text}${reason}` };
		}

		case 'permission.asked':
		case 'permission.updated': {
			// aichatoverview#258 — serve emits permission.asked (runtime v1.18.16; legacy 1.17.9 used
			// permission.updated) when a tool asks for a permission, e.g. external_directory for
			// out-of-workspace access. Headless deploy has nobody to approve, so the session would
			// stall until the handler's 300s timeout; surface it as a TERMINAL error instead.
			// In-workspace actions are auto-allowed in the deployed mode (normal replies work today),
			// so only real asks that would stall reach here. Dual-name match keeps both runtimes mapped.
			if (props.sessionID !== sessionID) return null;
			return { type: 'error', message: stringifyPermissionAsk(props) };
		}

		default:
			return null;
	}
}

/**
 * aichatoverview#258 — build the permission-ask error message. The v1.18.16 payload is
 * {permission, patterns[], always[], tool:{messageID}} (no title); legacy 1.17.9 is
 * {type, pattern, title}. Read the NEW field names first, fall back to the old ones so both
 * runtime versions surface the specific permission kind + target.
 */
function stringifyPermissionAsk(props: Record<string, unknown>): string {
	const kind = pickString(props, ['permission', 'type']) ?? 'permission';
	const detail = permissionAskDetail(props);
	const suffix = detail ? ` (${detail})` : '';
	return `opencode requested permission: ${kind}${suffix} — headless cannot approve`;
}

/** First non-empty string among the given keys. */
function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const v = obj[key];
		if (typeof v === 'string' && v.length > 0) return v;
	}
	return undefined;
}

/** Human-readable ask target: metadata.filepath/parentDir (v1.18.16) → `patterns` → legacy `pattern` → `title`. */
function permissionAskDetail(props: Record<string, unknown>): string | undefined {
	// v1.18.16 asks carry metadata with the CONCRETE target (e.g. the file being read) — most specific.
	const metadata = props.metadata;
	if (metadata && typeof metadata === 'object') {
		const meta = metadata as Record<string, unknown>;
		for (const key of ['filepath', 'parentDir']) {
			const v = meta[key];
			if (typeof v === 'string' && v.length > 0) return v;
		}
	}
	for (const key of ['patterns', 'pattern']) {
		const v = props[key];
		if (Array.isArray(v)) {
			const strings = v.filter((x): x is string => typeof x === 'string');
			if (strings.length > 0) return strings.join(', ');
		}
		if (typeof v === 'string' && v.length > 0) return v;
	}
	return pickString(props, ['title']);
}

/** Best-effort stringify of an opencode error payload into a human-readable message. */
function stringifyError(error: unknown): string {
	if (error == null) return 'opencode session error';
	if (typeof error === 'string') return error;
	if (typeof error === 'object') {
		const obj = error as Record<string, unknown>;
		// opencode errors are { name, data:{ message? } }-ish; surface the most useful field.
		const data = obj.data as Record<string, unknown> | undefined;
		const message = (data?.message ?? obj.message) as unknown;
		if (typeof message === 'string' && message.length > 0) {
			return typeof obj.name === 'string' ? `${obj.name}: ${message}` : message;
		}
		if (typeof obj.name === 'string') return obj.name;
		try {
			return JSON.stringify(error);
		} catch {
			return 'opencode session error';
		}
	}
	return String(error);
}
