# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

aichat-plugins is a monorepo providing the bridge between HuLa-Server (IM backend) and AI assistants (openclaw gateway). It has a two-layer architecture:

- **aichat-node** (`packages/node`): WS bridge — connects HuLa-Server WS on one side, openclaw gateway WS-RPC on the other
- **aichat-claw** (`packages/claw`): openclaw native Plugin — registers HuLa Channel + Agent Tools (`hula_send_message`, `hula_find_friend`)

Data flow: `User → HuLa-Server WS → aichat-node WS → openclaw gateway WS-RPC → agent pipeline`. The agent sends replies back via the `hula_send_message` Tool (registered by aichat-claw), not by raw text output.

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

# Activate aichat-node (one-time, generates ~/.aichat/credentials.jsonc)
pnpm -r --filter @aichat/node exec aichat activate --token <token>

# Start aichat-node
pnpm -r --filter @aichat/node exec aichat start

# CLI commands (require running aichat-node or direct package exec)
pnpm -r --filter @aichat/node exec aichat send-message --room <id> --content <text>
pnpm -r --filter @aichat/node exec aichat group-config --room <id>
```

No test runner is configured in this repo — verification is manual via CLI + runtime logs.

## Architecture

### WS Protocol (`packages/node/src/stream/protocol.ts`)

Defines the bidirectional message protocol between aichat-node and HuLa-Server:

- Plugin → Server: `HEARTBEAT(2)`, `ACK(15)`, `STREAM_START(17)`, `STREAM_DELTA(18)`, `STREAM_END(19)`, `THINKING_START(20)`, `THINKING_DELTA(21)`, `THINKING_END(22)`
- Server → Plugin: `receiveMessage`, `thinkingStart`, `thinkingDelta`, `thinkingEnd`, `groupConfigChange`, `tokenExpired`, `aiclawAuthRequest`

Key invariant: THINKING_START sends `triggerMsgId`; the server broadcasts back `thinkingId` in `thinkingStart`. All subsequent `THINKING_DELTA` must include `thinkingId`. The handler buffers deltas until `thinkingId` is backfilled (`packages/node/src/handler/message.ts:handleThinkingStartBroadcast`).

### Agent Loop (REQ-004)

`MessageHandler` (`packages/node/src/handler/message.ts`) drives the agent loop:

1. Receive text message → send ACK → dedupe by `msgId`
2. Skip own messages, non-text, `autoReply` messages, AI messages (if `respondToAi=false`)
3. AntiLoopGuard check (`packages/node/src/handler/anti-loop.ts`) — exponential backoff after 5 AI-to-AI rounds
4. Debounce merge (2s / 5 msg cap / 10s max) via `MessageDebouncer`
5. Trigger `adapter.chat()` with `ThinkingCallbacks`
6. Stream `THINKING_DELTA` chunks → `THINKING_END` on completion/error/timeout (5min)

### ClawAdapter Interface (`packages/node/src/claw/interface.ts`)

All claw backends implement `ClawAdapter`:
- `connect()` / `disconnect()` / `isConnected`
- `chat(message, sessionKey, callbacks)` — where `sessionKey = aiclaw-{uid}-room-{roomId}`
- `ThinkingCallbacks`: `onThinkingDelta(chunk)`, `onThinkingEnd(durationMs)`, `onError(error)`

Only `OpenclawAdapter` is implemented (`packages/node/src/claw/openclaw.ts`). It connects to openclaw gateway via WebSocket RPC with device identity signature (v3 payload) + token auth.

### openclaw Gateway Protocol (`packages/node/src/claw/openclaw.ts`)

WebSocket RPC frame types: `req`/`res`/`event`. After connect handshake (`connect.challenge` → `connect` req → `hello-ok` res):

- Agent chat: send `agent` req with `{ message, sessionKey, idempotencyKey }`
- Streamed via `event` frames: `assistant` stream = thinking deltas; `lifecycle` stream with `phase=end/error` = completion
- The message is prefixed with tool-use instructions (plain text, NOT `[SYSTEM]` markers — filtered by openclaw security)

### aichat-claw Plugin (`packages/claw/src/index.ts`)

Plugin entry registered with openclaw at runtime. Key behaviors:
- Registers HuLa Channel (`id='hula'`, `chatTypes=['direct', 'group']`)
- Registers Agent Tools: `hula_send_message`, `hula_find_friend`
- `AgentTool` interface uses `parameters` (NOT `schema`) — this is required by openclaw's `Tool<TParameters>`
- Config resolution is multi-path + env fallback (`HULA_AICLAW_TOKEN`, `HULA_SERVER_URL`) because OpenClaw 2026.3.13 does not pass `runtime.config` to auto-discovered plugins

### Multi-Token Support (`packages/claw/src/hula-api-pool.ts`)

`HulaApiClientPool` supports multiple aiclaw tokens. Currently limited because `AgentTool.execute()` receives no execution context — the default client is used. Future openclaw versions may provide agent identity in tool context.

### Authentication Flow

1. `aichat activate --token <token>` → HTTP POST to HuLa-Server → receives `{ uid, connectionToken, machineCode }` → writes `~/.aichat/credentials.jsonc`
2. `aichat start` → reads credentials → connects HuLa-Server WS with `Token` header + `Sec-WebSocket-Protocol: aiclaw-v1, clientId_{machineCode}`
3. openclaw gateway auth: reads `~/.openclaw/identity/device.json` (Ed25519 keypair) → signs v3 connect payload + token

### Configuration

Config files (JSONC with `//` comment support):
- `~/.aichat/config.jsonc` — server URL, openclaw gateway URL/token (optional)
- `~/.aichat/credentials.jsonc` — auto-generated by `activate`
- `~/.openclaw/openclaw.json` — auto-detected for gateway token
- Environment vars: `HULA_AICLAW_TOKEN`, `HULA_SERVER_URL`, `OPENCLAW_TOKEN`, `OPENCLAW_GATEWAY_URL`

## Scope Rules

This repo is part of the AIChat(HuLa) project collaboration network via `claude-peers`.

**Identity:** Use `whoami` to confirm your current peer ID and role. Do NOT assume a fixed identity.

| Peer ID | Role | Scope |
|---------|------|-------|
| manager | manager | PRD, task coordination, teamdocs maintenance |
| frontend-dev | developer | HuLa + HuLa-Admin frontend |
| server-dev | developer | HuLa-Server backend |
| plugin-dev | developer | aichat-plugins bridge |
| backend-tester | tester | API/integration testing, CI/CD, runtime env |
| ui-tester | tester | Windows/Android client testing |
| reviewer | reviewer | PRD review, code review (reports to manager) |

**Code ownership:** Only modify `packages/` files. All code changes must go through PR — no direct push to `dev` or `master`. Coordinate with the relevant peer before cross-package changes.

**Coordination:** Update `set_summary` daily. Use `send_message` for short comms; write to `teamdocs/` for docs/reports.

## graphify

This project maintains a knowledge graph at `graphify-out/`.

- Before answering architecture questions, read `graphify-out/GRAPH_REPORT.md` for god nodes and community structure
- After modifying code files in a session, run: `python3 -c "from graphify.watch import _rebuild_code; from pathlib import Path; _rebuild_code(Path('.'))"` to keep the graph current

## Git Submodules

- `teamdocs/` is a git submodule pointing to `https://github.com/hua0424/aichat-hula-docs.git`
- To update: `git submodule update --remote teamdocs` then commit the updated submodule ref
- Do not directly commit files inside `teamdocs/` from this repo — go into `teamdocs/` and commit from there

## Key Invariants

1. **Tool interface field name:** `AgentTool.parameters` (not `schema`). Mismatch causes `tool.parameters === undefined` → agent tool call throws.
2. **Message prefix:** Must NOT use `[SYSTEM]`, `[System Message]`, or similar markers — filtered by openclaw security hardening.
3. **Tool profile allowlist:** openclaw `tools.profile` (messaging/coding/minimal) filters available tools. Plugin tools must be added via `tools.alsoAllow: ["hula_send_message", "hula_find_friend"]` in `openclaw.json`.
4. **Plugin config delivery:** OpenClaw 2026.3.13 does not pass `runtime.config` to auto-discovered plugins. Environment variables are the reliable workaround.
5. **Thinking session lifecycle:** `THINKING_START` → (buffer deltas) → `thinkingId` backfilled → flush buffered deltas → `THINKING_DELTA` stream → `THINKING_END`. Always guard against double-finalization with `session.finalized`.
6. **AutoReply extra field:** Messages sent with `extra: { autoReply: true }` are skipped by the handler to prevent self-trigger loops.
7. **AI-to-AI backoff:** After 5 consecutive AI-to-AI rounds, exponential delay kicks in (5s → 15s → 30s). Human messages reset the counter.
