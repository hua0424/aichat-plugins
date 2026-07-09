# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

aichat-plugins is a monorepo providing the bridge between HuLa-Server (IM backend) and AI assistants (openclaw gateway). It has a two-layer architecture:

- **aichat-node** (`packages/node`): WS bridge — connects HuLa-Server WS on one side, openclaw gateway WS-RPC on the other
- **aichat-claw** (`packages/claw`): openclaw native Plugin — registers the HuLa Channel + a `resolve_exec_env` hook that injects the room binding so the agent replies via the unified `aichat send-message` CLI (ADR-0004; Agent Tools retired in aichatoverview#161)

Data flow: `User → HuLa-Server WS → aichat-node WS → openclaw gateway WS-RPC → agent pipeline`. The agent sends replies back by running `aichat send-message --content "…"` in bash — room/identity are bound automatically via the exec-env hook — NOT by raw text output and NOT via an in-gateway tool.

## Development Commands

All commands run from repo root:

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Type-check without emitting
pnpm lint

# Dev mode — hot reload aichat-node
pnpm dev

# Build individual package
pnpm -r --filter @aichat/node build
pnpm -r --filter aichat-claw build

# Activate aichat-node (one-time per token, idempotent — writes ~/.aichat/credentials/<sha16>.jsonc)
pnpm -r --filter @aichat/node exec aichat activate --token <token>

# Start aichat-node
pnpm -r --filter @aichat/node exec aichat start

# CLI commands (require running aichat-node or direct package exec)
pnpm -r --filter @aichat/node exec aichat send-message --room <id> --content <text>
pnpm -r --filter @aichat/node exec aichat group-config --room <id>
```

Tests run with vitest: `pnpm test` (node ~521 + claw ~18). Runtime verification is via CLI + logs on the deployed host.

## Architecture

### WS Protocol (`packages/node/src/stream/protocol.ts`)

Defines the bidirectional message protocol between aichat-node and HuLa-Server:

- Plugin → Server: `HEARTBEAT(2)`, `ACK(15)`, `THINKING_START(20)`, `THINKING_DELTA(21)`, `THINKING_END(22)` (frame numbers 17-19 = retired `STREAM_START/DELTA/END`, reserved-not-reused since aichatoverview#164)
- Server → Plugin: `receiveMessage`, `thinkingStart`, `thinkingDelta`, `thinkingEnd`, `groupConfigChange`, `tokenExpired`, `aiclawAuthRequest`

Key invariant: THINKING_START sends `triggerMsgId`; the server broadcasts back `thinkingId` in `thinkingStart`. All subsequent `THINKING_DELTA` must include `thinkingId`. The handler buffers deltas until `thinkingId` is backfilled (`packages/node/src/handler/message.ts:handleThinkingStartBroadcast`).

### Agent Loop (REQ-004)

`MessageHandler` (`packages/node/src/handler/message.ts`) drives the agent loop:

1. Receive text message → send ACK → dedupe by `msgId`
2. Skip own messages, non-text, `autoReply` messages, AI messages (if `respondToAi=false`)
3. AntiLoopGuard check (`packages/node/src/handler/anti-loop.ts`) — exponential backoff after 5 AI-to-AI rounds
4. Debounce merge (2s / 5 msg cap / 10s max) via `MessageDebouncer`
5. Trigger the identity's `AgentDriver` chat turn
6. Stream `THINKING_DELTA` chunks → `THINKING_END` on completion/error/timeout (5min)

### AgentDriver (`packages/node/src/agent/`)

Every agent backend is one driver directory implementing the unified `AgentDriver` seam (ADR-0001/0003), emitting normalized `AgentEvent`s (`events.ts`): `agent/openclaw/` · `agent/opencode/` · `agent/codex/` · `agent/cc/`. Adding an agent = adding one driver directory; nothing above the seam changes. (The former `ClawAdapter`/`OpenclawAdapter` two-layer shape was melted into `agent/openclaw/openclaw-driver.ts` in aichatoverview#162.)

The openclaw driver connects to the openclaw gateway via WebSocket RPC with device identity signature (v3 payload) + token auth.

### openclaw Gateway Protocol (`packages/node/src/agent/openclaw/openclaw-driver.ts`)

WebSocket RPC frame types: `req`/`res`/`event`. After connect handshake (`connect.challenge` → `connect` req → `hello-ok` res):

- Agent chat: send `agent` req with `{ message, sessionKey, idempotencyKey }`
- Streamed via `event` frames: `assistant` stream = thinking deltas; `lifecycle` stream with `phase=end/error` = completion
- The message is prefixed with a role-instruction telling the agent to reply by running `aichat send-message --content "…"` in bash (plain text, NOT `[SYSTEM]` markers — filtered by openclaw security). Built by the shared `buildReplyInstruction` (`packages/node/src/agent/reply-contract.ts` — single source for openclaw/opencode/codex; cc wraps the same base, since aichatoverview#165).

### aichat-claw Plugin (`packages/claw/src/index.ts`)

Plugin entry registered with openclaw at runtime. Post-ADR-0004 (aichatoverview#161) it does exactly two things:
- Registers the HuLa Channel (`id='hula'`, `chatTypes=['direct', 'group']`) so openclaw routes direct/group chats.
- Registers a `resolve_exec_env` hook (`exec-env.ts`): strips the `agent:main:` prefix off the compound sessionKey, extracts the opaque token, and injects it as `OPENCLAW_BIND`. The `aichat` CLI reads it and emits `openclaw:<token>` to the node's loopback CapabilityEndpoint, which resolves it (exact store lookup) back to `(aiclawUid, roomId)`.

The Agent Tools (`hula_send_message` / `hula_find_friend` / `hula_skip_reply`) and the plugin's own HuLa API client (`hula-api.ts` / `hula-api-pool.ts`) + tail-parsing `session-key.ts` are **retired** — the plugin no longer holds any HuLa credentials; the credential trust point is the single aichat-node server. Replies flow through the same `aichat send-message` CLI path as opencode/codex/cc.

### Authentication Flow

1. `aichat activate --token <token>` → delegates to `resolveAgentCredential` (registry.ts): HTTP POST to HuLa-Server → receives `{ uid, connectionToken, machineCode }` → cached per-token at `~/.aichat/credentials/<sha16>.jsonc` (idempotent — re-running with the same token reuses the cache, since aichatoverview#164)
2. `aichat start` → resolves each registry entry's credential (same cache) → connects HuLa-Server WS with `Token` header + `Sec-WebSocket-Protocol: aiclaw-v1, clientId_{machineCode}`
3. openclaw gateway auth: reads `~/.openclaw/identity/device.json` (Ed25519 keypair) → signs v3 connect payload + token

### Configuration

Config files (JSONC with `//` comment support):
- `~/.aichat/config.jsonc` — server URL, openclaw gateway URL/token (optional), and the **required** `agents` registry: `{ "agents": [{ "tool": "openclaw", "token": "<激活 token>" }] }`. Since aichatoverview#163 `aichat start` is multi-identity only — an empty/missing registry exits with a migration hint (single identity = a registry of length 1).
- `~/.aichat/credentials/<sha16>.jsonc` — per-token credential cache, auto-generated by `activate`/`start` (the legacy singular `credentials.jsonc` is gone since aichatoverview#164)
- `~/.openclaw/openclaw.json` — auto-detected for gateway token
- Environment vars: `OPENCLAW_TOKEN`, `OPENCLAW_GATEWAY_URL`

## Key Invariants

1. **Message prefix:** Must NOT use `[SYSTEM]`, `[System Message]`, or similar markers — filtered by openclaw security hardening.
2. **Compound sessionKey (openclaw):** `OpenclawDriver.openSession` builds `<token>:aiclaw-{uid}-room-{roomId}` — opaque token FIRST, then a literal `:`, then the plaintext binding LAST. exec-env's `buildOpenclawExecEnv` extracts the token PREFIX → `OPENCLAW_BIND`; the node's CapabilityEndpoint keys on the BARE token alone (never split the compound — a compound arriving at the endpoint = forgery → store miss). This format is preserved (openclaw gateway-side session isolation); only the retired tools' tail-parsing consumer was removed.
3. **Thinking session lifecycle:** `THINKING_START` → (buffer deltas) → `thinkingId` backfilled → flush buffered deltas → `THINKING_DELTA` stream → `THINKING_END`. Always guard against double-finalization with `session.finalized`.
4. **AutoReply extra field:** Messages sent with `extra: { autoReply: true }` are skipped by the handler to prevent self-trigger loops.
5. **AI-to-AI backoff:** After 5 consecutive AI-to-AI rounds, exponential delay kicks in (5s → 15s → 30s). Human messages reset the counter.
6. **Plugin manifest `configSchema` is mandatory:** openclaw 2026.6.5's gateway **refuses to start** if a configured plugin's `openclaw.plugin.json` lacks a `configSchema` (`Gateway failed to start: plugin manifest requires configSchema`), taking the whole container down. It must be a non-empty object schema (`{type:"object", properties:{…}}`) — `{}` and a bare `{type:"object"}` are both rejected. Keep it even though aichat-claw consumes no config (guarded by `packaging.test.ts`).
