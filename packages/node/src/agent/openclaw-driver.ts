import type { AgentDriver, AgentSession, AgentEvent } from './events.js';
import type { ClawAdapter, ThinkingCallbacks } from '../claw/interface.js';
import type { BindTokenStore } from './bind-token-store.js';

/**
 * REQ (openclaw empty thinking): upstream openclaw's built-in agent contract emits the literal
 * string `NO_REPLY` on its `assistant` text stream when it has no user-visible prose to add (the
 * reply itself already went out via the hula_send_message tool); it ALSO emits a purely empty /
 * whitespace-only assistant stream on some turns. We consume that stream as thinking text, so both
 * the bare sentinel and an empty stream would otherwise land as a blank/broken thinking panel / DB
 * row. Filter both — but for the sentinel ONLY when the WHOLE thinking text is the sentinel
 * (openclaw's own regex is whole-string with optional surrounding whitespace), so a real thought
 * that merely CONTAINS "NO_REPLY" survives verbatim.
 *
 * Note: `.test()` on a non-global regex is stateless — do NOT add the `g` flag (lastIndex would
 * make repeated calls non-deterministic).
 */
export const OPENCLAW_NO_REPLY_SENTINEL = /^\s*NO_REPLY\s*$/;
/** Neutral placeholder for an openclaw turn with no real thinking prose (bare NO_REPLY sentinel OR
 *  empty/whitespace-only assistant stream). Deliberately makes NO claim about whether a reply was
 *  sent: the node can't know that at finalize time (reply goes out-of-band via the openclaw tool),
 *  and empty-turns with no reply exist — so "回复已直接发出" would be false for them. */
export const OPENCLAW_EMPTY_THINKING_PLACEHOLDER = '（本轮无思考正文）';

/** openclaw-only: bare NO_REPLY sentinel OR empty/whitespace-only thinking → neutral placeholder;
 *  any real thinking (even if it merely CONTAINS "NO_REPLY") is returned verbatim. */
export function filterOpenclawThinking(content: string): string {
	return OPENCLAW_NO_REPLY_SENTINEL.test(content) || content.trim() === ''
		? OPENCLAW_EMPTY_THINKING_PLACEHOLDER
		: content;
}

/**
 * REQ-008 #75 — OpenclawDriver: the first AgentDriver, a thin WRAPPER around the
 * unchanged OpenclawAdapter WS engine. It bridges the adapter's push-style
 * ThinkingCallbacks into the pull-style AgentEvent async stream; it does NOT
 * reimplement any handshake / reconnect / event-routing logic.
 */
export class OpenclawDriver implements AgentDriver {
	readonly type = 'openclaw';

	constructor(
		private readonly adapter: ClawAdapter,
		private readonly bindTokens: BindTokenStore,
	) {}

	/**
	 * BL-014 (#141) — resolve the openclaw capability session id back to its bound identity+room.
	 *
	 * The CLI/exec-env path delivers a BARE opaque node-minted token here (aichat-claw's resolve_exec_env
	 * hook extracts the token PREFIX out of the compound sessionKey and injects it as OPENCLAW_BIND, the
	 * CLI emits `openclaw:<token>`, and resolveBoundSession strips the `openclaw:` prefix before calling
	 * this). So this is an EXACT STORE LOOKUP, NOT a parse and NOT a split.
	 *
	 * #141 B+ (regression fix): openSession now hands the adapter a COMPOUND `<token>:<binding>`
	 * sessionKey (see openSession). resolveSession must NOT split that compound — it looks up the whole
	 * argument as-is. The only thing that legitimately reaches here is the bare token; a forged plaintext
	 * binding, OR a compound an attacker appends a binding tail to, is never a stored key → undefined
	 * (the endpoint then 404s). The compound only legitimately exists gateway-side, inside adapter.chat.
	 */
	resolveSession(sessionKey: string): { aiclawUid: string; roomId: string } | undefined {
		return this.bindTokens.resolve(sessionKey);
	}

	/**
	 * aichatoverview#124 — no per-room store: openclaw's binding IS the sessionKey, so there is
	 * nothing to reset. No-op, returns false.
	 */
	resetSession(): boolean {
		return false;
	}

	async connect(): Promise<void> {
		await this.adapter.connect();
	}

	async disconnect(): Promise<void> {
		await this.adapter.disconnect();
	}

	async openSession(o: {
		aiclawUid: string;
		roomId: string;
		chatContext: Record<string, unknown>;
	}): Promise<AgentSession> {
		// #141 B+ (regression fix): openclaw does NOT reply via the `aichat` CLI — it replies via the
		// in-gateway aichat-claw `hula_send_message` TOOL, which resolves ctx.sessionKey by PARSING the
		// plaintext binding (`/(?:^|[:/])aiclaw-\d+-room-\d+$/`). openclaw carries ONE sessionKey shared by
		// BOTH the tool path (needs the plaintext binding) and the CLI/exec-env path (needs an unforgeable
		// token). So we carry BOTH in ONE COMPOUND sessionKey: `<token>:<binding>` — the opaque token
		// FIRST, a literal `:`, then the plaintext binding LAST.
		//   • The binding is LAST so the tool's `$`-anchored regex matches it (the char before `aiclaw` is `:`).
		//   • The token is a base64url string (`[A-Za-z0-9_-]`, contains no `:`) so the split is unambiguous.
		//   • aichat-claw's resolve_exec_env extracts the token PREFIX → OPENCLAW_BIND → CLI `openclaw:<token>`.
		// CONFINEMENT: this compound is used ONLY here, as adapter.chat's sessionKey. It is NEVER a
		// node-internal key — the node-side thinking sessionKey is computed independently from (uid,room)
		// in the message handler, and resolveSession keys on the BARE token alone (it must NOT split the
		// compound; a compound arriving at the endpoint = forgery → store miss → undefined).
		// mint() is stable per (uid,room), so the openclaw conversation sessionKey stays constant.
		const token = this.bindTokens.mint(o.aiclawUid, o.roomId);
		const sessionKey = `${token}:aiclaw-${o.aiclawUid}-room-${o.roomId}`;
		return new OpenclawSession(this.adapter, sessionKey, o.roomId);
	}
}

/**
 * One in-flight agent turn over the OpenclawAdapter (single-flight for this slice).
 * send() returns an async iterable backed by a minimal push→pull queue so events
 * fired by the adapter's callbacks (possibly synchronously, before the consumer
 * awaits) are buffered and never lost.
 */
class OpenclawSession implements AgentSession {
	private closed = false;
	/**
	 * REQ-008 #75 P1-1①: the in-flight stream's `finish` closure, registered when
	 * send() starts. close() calls it to wake a consumer parked on the await inside
	 * the async iterator (single-flight per session for this slice). Calling finish
	 * twice is a no-op (it guards on `done`), so this stays idempotent; after a send
	 * completes a stale closeActive pointing at an already-finished stream is harmless.
	 */
	private closeActive: (() => void) | null = null;

	constructor(
		private readonly adapter: ClawAdapter,
		private readonly sessionKey: string,
		private readonly roomId: string,
	) {}

	send(message: string): AsyncIterable<AgentEvent> {
		const buffer: AgentEvent[] = [];
		let done = false;
		let resolveNext: (() => void) | null = null;

		const wake = () => {
			if (resolveNext) {
				const r = resolveNext;
				resolveNext = null;
				r();
			}
		};
		const push = (ev: AgentEvent) => {
			if (done) return;
			buffer.push(ev);
			wake();
		};
		const finish = () => {
			if (done) return;
			done = true;
			wake();
		};
		// Register this stream's finish so close() can wake a parked iterator.
		this.closeActive = finish;

		const callbacks: ThinkingCallbacks = {
			onThinkingDelta: (text) => push({ type: 'thinking', text }),
			// REQ-010 S1: the terminal AgentEvent is retired. The openclaw adapter still sends its
			// reply internally (inside the gateway via aichat-claw's own tool), so an observed
			// terminal tool no longer needs to surface as an AgentEvent — reduceThinking's ledger
			// that used to consume it is gone. We simply don't bridge onTerminalTool.
			onThinkingEnd: (durationMs) => {
				push({ type: 'done', durationMs });
				finish();
			},
			onError: (err) => {
				push({ type: 'error', message: err.message });
				finish();
			},
		};

		// Fire the adapter chat. Errors from the call itself surface as an error event.
		this.adapter.chat(message, this.sessionKey, callbacks, { roomId: this.roomId }).catch((err) => {
			push({ type: 'error', message: err instanceof Error ? err.message : String(err) });
			finish();
		});

		const isClosed = () => this.closed;

		return {
			async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
				while (true) {
					while (buffer.length > 0) {
						yield buffer.shift()!;
					}
					if (done || isClosed()) return;
					await new Promise<void>((resolve) => {
						resolveNext = resolve;
					});
				}
			},
		};
	}

	async close(): Promise<void> {
		this.closed = true;
		// REQ-008 #75 P1-1①: wake a consumer parked on the await inside the iterator.
		// finish() marks done + wakes the pending resolveNext; the iterator then drains
		// any remaining buffer (drain-before-done ordering preserved) and returns.
		// Idempotent: finish guards on `done`, so a repeat / post-completion call is a no-op.
		if (this.closeActive) this.closeActive();
	}
}
