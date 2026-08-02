/**
 * REQ-013 S1 — the SINGLE SOURCE of the unified inbound-attribution envelope for ALL FOUR agent
 * drivers (openclaw / opencode / codex / cc). Assembled at the handler's common message-build layer
 * (before the message is dispatched to any driver), so every driver receives the SAME format instead
 * of each inventing its own. The shape is CC's proven per-sender-attributed transcript (resurrected
 * from commit 645fec2), now applied uniformly for BOTH group and DM:
 *   DM    (roomType===2) → `[HuLa 私聊]\n[fromName(fromUid)]: <message>`
 *   group (else)         → `[HuLa 群聊]\n<accumulated lines>\n[fromName(fromUid)]: <current message>`
 * where `<accumulated lines>` are the already-`[name(uid)]: content`-formatted un-@ group-context
 * lines the handler consumed for this turn. A naturally-attributed chat transcript (not bare/imperative
 * text) is load-bearing for CC's anti-prompt-injection defence; the other three drivers simply gain a
 * consistent, attributed envelope. This is pure — no I/O, no side effects.
 *
 * #188: optional `persona` (the aiclaw's owner-configured 人设). When non-blank it is prepended as a
 * delimited block BEFORE the room header; the rest of the envelope stays byte-identical:
 *   `[HuLa 人设开始]\n<persona verbatim>\n[HuLa 人设结束]\n` + original envelope.
 * Absent / empty / whitespace-only persona → output byte-identical to the pre-feature format (AC6).
 */
export function buildAgentEnvelope(o: {
	roomType: number;
	fromName: string;
	fromUid: string;
	accumulated: string[];
	message: string;
	persona?: string;
}): string {
	const room = o.roomType === 2 ? '[HuLa 私聊]' : '[HuLa 群聊]';
	const currentLine = `[${o.fromName}(${o.fromUid})]: ${o.message}`;
	const lines = o.accumulated.length > 0 ? [...o.accumulated, currentLine] : [currentLine];
	const envelope = `${room}\n${lines.join('\n')}`;
	if (o.persona === undefined || o.persona.trim() === '') return envelope;
	return `[HuLa 人设开始]\n${o.persona}\n[HuLa 人设结束]\n${envelope}`;
}
