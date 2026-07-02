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
 */
export function buildAgentEnvelope(o: {
	roomType: number;
	fromName: string;
	fromUid: string;
	accumulated: string[];
	message: string;
}): string {
	const room = o.roomType === 2 ? '[HuLa 私聊]' : '[HuLa 群聊]';
	const currentLine = `[${o.fromName}(${o.fromUid})]: ${o.message}`;
	const lines = o.accumulated.length > 0 ? [...o.accumulated, currentLine] : [currentLine];
	return `${room}\n${lines.join('\n')}`;
}
