# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

agentchannels (`ach`) is a TypeScript CLI tool that bridges messaging platforms to Claude Managed Agent sessions. Each Slack thread becomes a multi-turn streaming conversation with a Claude agent via Socket Mode (no public URL needed).

## Commands

```bash
pnpm install          # Install dependencies
pnpm build            # Compile TypeScript (tsc → dist/)
pnpm dev -- serve     # Dev mode with tsx (no build needed)
pnpm start            # Run compiled: node dist/cli/index.js serve
pnpm test             # Run all tests (vitest run)
pnpm test:watch       # Watch mode
pnpm lint             # Type-check only (tsc --noEmit)

# Run a single test file
npx vitest run tests/core/chunk-parser.test.ts

# Run tests matching a pattern
npx vitest run -t "parseSSEEvent"
```

## Architecture

### Design principle: Channel adapter pattern

The core abstraction is the `ChannelAdapter` interface (`src/core/channel-adapter.ts`) that decouples messaging platforms from the agent-bridging logic. Adding a new channel (Discord, Teams, etc.) requires only implementing this interface — all session management, streaming coordination, and retry logic are channel-agnostic.

### Module layers

```
┌─────────────────────────────────────────────────────────────┐
│  CLI Layer (src/cli/index.ts)                               │
│  commander program: ach serve | init slack | init agent |   │
│  deploy railway                                             │
└──────────┬──────────────────────────────────────────────────┘
           │
┌──────────▼──────────────────────────────────────────────────┐
│  Command Layer (src/commands/, src/deploy/)                  │
│  serve.ts — wires adapter + bridge + client                 │
│  init-agent.ts — interactive agent/env creation wizard      │
│  railway.ts — deployment wizard                             │
└──────────┬──────────────────────────────────────────────────┘
           │
┌──────────▼──────────────────────────────────────────────────┐
│  Core Layer (src/core/)                                     │
│  StreamingBridge ← SessionOutputReader ← AgentClient        │
│  SessionManager, chunk-parser, tool-descriptions            │
│  agent.ts / environment.ts — CRUD helpers for Anthropic API │
│  config.ts — three-source config resolution                 │
└──────────┬──────────────────────────────────────────────────┘
           │
┌──────────▼──────────────────────────────────────────────────┐
│  Channel Layer (src/channels/slack/)                         │
│  SlackAdapter (ChannelAdapter impl) — Socket Mode listener  │
│  SlackPoster, ThreadResponder, RateLimiter, MessageBatcher  │
│  init.ts — Slack app creation wizard                        │
│  api.ts — Slack Configuration Token API client              │
│  oauth.ts — local OAuth server for app installation         │
│  manifest.ts — Slack app manifest builder                   │
└─────────────────────────────────────────────────────────────┘
```

### `ach serve` — Main message flow

This is the primary runtime path. `serve.ts` wires the components:

```
1. Slack event (app_mention or message.im)
   │
2. SlackAdapter.setupListeners() dispatches to registered handlers
   │  Strips bot @mention from text, normalizes to ChannelMessage
   │
3. StreamingBridge.handleMessage(message)
   │  ├─ Concurrency guard: one response per thread at a time
   │  ├─ Creates AbortController for cancellation
   │  │
   │  ├─ Phase 1: Session resolution
   │  │  SessionManager.getSession() or AgentClient.createSession()
   │  │  Key: "slack:{channelId}:{threadId}" → sessionId
   │  │
   │  ├─ Phase 2: Start streaming
   │  │  adapter.setStatus("Thinking...")
   │  │  adapter.startStream() → Slack chat.startStream API → StreamHandle
   │  │
   │  ├─ Phase 3: Stream agent response
   │  │  SessionOutputReader consumes AgentClient.sendMessage() generator
   │  │  ├─ text_delta → StreamHandle.append() → Slack chat.appendStream
   │  │  ├─ thinking → appendTasks() (plan-mode task indicators)
   │  │  ├─ tool_use → appendTasks() with human-readable description
   │  │  ├─ tool_result → marks task complete
   │  │  └─ error → captured for final phase
   │  │
   │  └─ Phase 4: Finalize
   │     StreamHandle.finish() → Slack chat.stopStream
   │     adapter.clearStatus()
   │     Returns BridgeResult { sessionCreated, sessionId, totalChars, ... }
```

### SSE event parsing pipeline

Claude Managed Agent API streams SSE events which are processed through a three-stage pipeline:

```
Anthropic SSE stream
  → AgentClient.sendMessage() (AsyncGenerator)
    Opens stream via client.beta.sessions.events.stream()
    Sends user message via client.beta.sessions.events.send()
    For each raw event: parseSSEEvent() → yields AgentStreamEvent[]

  → SessionOutputReader (EventEmitter + AsyncIterator)
    Wraps AgentClient.sendMessage() with retry logic
    Exponential backoff on transient errors (network, 5xx, overloaded)
    Distinguishes transient vs permanent errors via isTransientError()
    Emits typed events: text_delta, tool_use, tool_result, thinking, status, done, error

  → StreamingBridge
    Listens to SessionOutputReader events
    Routes to StreamHandle (append/appendTasks/finish)
    Tracks plan-mode tasks (thinking steps, tool use steps)
    Handles lifecycle: session_resolve → stream_start → streaming → completing → cleanup
```

### `AgentStreamEvent` discriminated union

The `chunk-parser.ts` transforms raw SSE events into these types:

| Event type | Source SSE events | Data |
|---|---|---|
| `text_delta` | `content_block_delta` (text), `agent.message` | `text: string` |
| `tool_use` | `content_block_start` (tool_use), `agent.tool_use`, `agent.mcp_tool_use`, `agent.custom_tool_use` | `name, input` |
| `tool_result` | `agent.tool_result`, `agent.mcp_tool_result` | `name?, toolUseId?` |
| `thinking` | `content_block_delta` (thinking), `agent.thinking`, `span.model_request_start` | `text?` |
| `status` | `session.status_running`, `session.status_rescheduled` | `status: string` |
| `done` | `session.status_idle`, `session.status_terminated`, `session.deleted` | `stopReason?` |
| `error` | `session.error` | `error: string` |

Terminal events (`done`, `error` from session.error, `session.status_terminated`) end the stream.

### `ach init slack` — Slack app setup flow

Three setup paths, all in `src/channels/slack/init.ts`:

- **Automatic**: User provides a Configuration Refresh Token (xoxe-...) → `SlackApiClient.rotateConfigToken()` → `createAppFromManifest()` → local OAuth server (`oauth.ts`) opens browser for workspace install → prompts for app-level token (xapp-...)
- **Guided**: Displays the JSON manifest, walks user through manual creation on api.slack.com, collects tokens via prompts
- **Manual**: User already has all three tokens, enters them directly

All paths end by writing `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET` to `.env`.

### `ach init agent` — Agent & environment setup

`src/commands/init-agent.ts` uses `src/core/agent.ts` and `src/core/environment.ts`:

- Validates API key via `AgentClient.validateAuth()` (lists agents as a health check)
- Interactive or `--non-interactive` mode
- Creates or validates agent via `client.beta.agents.create/retrieve`
- Creates or validates environment via `client.beta.environments.create/retrieve`
- Writes `CLAUDE_AGENT_ID`, `CLAUDE_ENVIRONMENT_ID` to `.env`

### `ach deploy railway` — Railway deployment

`src/deploy/railway.ts` + `railway-client.ts`:

- `RailwayClient` wraps Railway's GraphQL API (`backboard.railway.com/graphql/v2`)
- Wizard: authenticate → create project → read local `.env` → push env vars → deploy Docker image → generate domain

### Slack-specific streaming utilities

The Slack channel has two streaming approaches:

1. **Primary (used in production)**: `SlackAdapter.startStream()` → uses Slack's native `chat.startStream`/`appendStream`/`stopStream` API for real-time streaming with plan-mode task indicators

2. **Legacy alternative**: `SlackThreadResponder` → `SlackPoster` → `MessageBatcher` + `TokenBucketRateLimiter` — batches text deltas and posts as threaded replies with rate limiting. This is the older approach that splits long messages at Slack's 40K char limit. Still exported but `StreamingBridge` + native streaming is the current path.

### Config system

Two parallel config systems exist:

1. **`src/core/config.ts`** — Runtime config resolution for `ach serve`. Three-source precedence: CLI flags > `process.env` > `.env` file. Uses its own Zod schema with `resolveConfig()` (full validation) and `resolvePartialConfig()` (for init commands). `ConfigValidationError` provides structured error messages.

2. **`src/config/`** — Env file utilities and Zod schemas for Slack/Agent tokens. `writeEnvFile()` merges with existing `.env`, creates backups, and tracks added/overwritten keys. Used by all init wizards.

### Session management

`SessionManager` is an in-memory `Map<string, SessionEntry>` — no persistence. Key format: `"channelType:channelId:threadId"`. Optional TTL-based expiry. Sessions are lost on server restart (by design — users start a new thread).

### Thread concurrency

Both `StreamingBridge` and `SlackThreadResponder` prevent concurrent processing of the same thread. `StreamingBridge` uses per-thread `AbortController` for clean cancellation. `abortAll()` is called during graceful shutdown (SIGINT/SIGTERM).

## Conventions

- **ES Modules** — `"type": "module"` in package.json; all imports use `.js` extension
- **pnpm** — Package manager (pnpm@10.7.0)
- **Vitest** — Tests in `tests/` mirror `src/` structure; `globals: false` (explicit imports)
- **Zod v4** — Runtime validation for config schemas
- **No .env in repo** — Generated by `ach init slack` and `ach init agent` wizards
- **@inquirer/prompts** — All interactive CLI prompts (input, confirm, select, password)
- **@slack/bolt** — Slack SDK with Socket Mode
- **@anthropic-ai/sdk** — Uses `client.beta.agents`, `client.beta.sessions`, `client.beta.environments` (beta API surface)
- Tests mock external dependencies (Slack API, Anthropic SDK) — no live API calls in tests
