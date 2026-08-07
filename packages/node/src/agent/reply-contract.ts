/**
 * REQ-010 S1 / ADR-0004 — the single-sourced agent reply COMMAND literal.
 *
 * Every driver tells the agent the SAME thing: your text output is thinking (never shown to the user);
 * to actually reply you MUST run `aichat send-message --content "…"` in bash; the room + identity are
 * auto-bound (never pass them — anti-spoofing); no reply needed → don't run it.
 *
 * REQ-018 — the reply CONTRACT PROSE (the Chinese instructions each driver used to inline) is RETIRED
 * from the codebase: it now lives in server-fetched prompt templates (agent/prompt-templates.ts),
 * fetched fail-fast at startup (api/hula-api.ts getAgentPromptTemplates) and rendered into each
 * driver's SYSTEM layer at per-turn session open:
 *   - opencode → prompt body `system` field
 *   - codex / openclaw → workspace AGENTS.md marked block
 *   - cc → `claude --append-system-prompt`
 * The ONLY thing left here is the command literal, injected at render time via the `{reply_command}`
 * placeholder so the command string can never drift between drivers or templates.
 */

/** The exact reply CLI the agent must run to send a message (single-sourced so it can't drift). */
export const REPLY_COMMAND = 'aichat send-message --content "<你的回复>"';
