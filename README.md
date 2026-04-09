# agentchannels

Connect [Claude Managed Agents](https://docs.anthropic.com/en/docs/agents) to messaging channels. Start with Slack — add more channels later.

`agentchannels` (CLI: `ach`) is an open-source TypeScript tool that bridges messaging platforms to Claude Managed Agent sessions. Each Slack thread becomes a multi-turn conversation with a Claude agent, with responses streamed back in real time.

## How It Works

```
Slack thread  ──▶  agentchannels (ach serve)  ──▶  Claude Managed Agent
  @mention          Socket Mode listener           session per thread
  reply in thread   ◀── streaming response ◀──     multi-turn memory
```

1. A user **@mentions** the bot in a Slack channel → a new Claude agent session is created
2. The agent's response is **streamed** back into the Slack thread
3. Subsequent messages **in the same thread** reuse the session for multi-turn conversation
4. Direct messages to the bot also create sessions

## Prerequisites

- **Node.js** ≥ 18
- **pnpm** ≥ 10 (`npm install -g pnpm` or [other methods](https://pnpm.io/installation))
- **Anthropic API key** with Managed Agents access — get one at [console.anthropic.com](https://console.anthropic.com/)
- **Slack workspace** where you can create apps (requires admin or app-manager permissions)
- A **Slack Configuration Token** (`xoxe-...`) for automatic app creation, OR the ability to create a Slack app manually

## Quick Start

Get up and running in three commands:

```bash
# 1. Install
pnpm install -g agentchannels

# 2. Set up Slack app & credentials
ach init slack

# 3. Create a Claude Managed Agent & Environment
ach init agent

# 4. Start the server
ach serve
```

That's it. Mention your bot in any Slack channel and start chatting.

## Installation

### From npm (recommended)

```bash
pnpm install -g agentchannels
```

### From source

```bash
git clone https://github.com/anthropics/agentchannels.git
cd agentchannels
pnpm install
pnpm build
# Run via source:
pnpm start
# Or link globally:
pnpm link --global
```

## Configuration

All configuration can be provided via **environment variables**, a **`.env` file**, or **CLI flags**. They are resolved in this priority order (highest wins):

1. CLI flags (e.g., `--anthropic-api-key`)
2. Environment variables
3. `.env` file in the working directory

### Required Variables

| Variable | CLI Flag | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | `--anthropic-api-key` | Your Anthropic API key |
| `CLAUDE_AGENT_ID` | `--agent-id` | Claude Managed Agent ID |
| `CLAUDE_ENVIRONMENT_ID` | `--environment-id` | Claude Environment ID |
| `SLACK_BOT_TOKEN` | `--slack-bot-token` | Slack bot token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | `--slack-app-token` | Slack app-level token (`xapp-...`) for Socket Mode |
| `SLACK_SIGNING_SECRET` | `--slack-signing-secret` | Slack app signing secret |

### Example `.env` File

```env
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_AGENT_ID=agent_...
CLAUDE_ENVIRONMENT_ID=env_...
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=abc123...
```

> The `ach init slack` and `ach init agent` wizards write these values to `.env` automatically.

## CLI Commands

### `ach init slack`

Interactive wizard that creates a Slack app and configures credentials.

```bash
ach init slack
```

The wizard will:
1. Ask for your Slack Configuration Token (or guide you to create one)
2. Create a Slack app with the correct manifest (bot scopes, Socket Mode, event subscriptions)
3. Generate bot and app-level tokens
4. Write `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, and `SLACK_SIGNING_SECRET` to `.env`

#### Manual Slack Setup

If you prefer to create the Slack app manually:

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest**
2. Use this manifest (YAML):
   ```yaml
   display_information:
     name: My Claude Agent
     description: Claude Managed Agent bot
   features:
     bot_user:
       display_name: Claude Agent
       always_online: true
   oauth_config:
     scopes:
       bot:
         - app_mentions:read
         - chat:write
         - im:history
         - im:read
         - im:write
   settings:
     event_subscriptions:
       bot_events:
         - app_mention
         - message.im
     interactivity:
       is_enabled: false
     org_deploy_enabled: false
     socket_mode_enabled: true
   ```
3. Under **OAuth & Permissions**, install the app to your workspace and copy the **Bot User OAuth Token** (`xoxb-...`)
4. Under **Basic Information** → **App-Level Tokens**, generate a token with `connections:write` scope (`xapp-...`)
5. Copy the **Signing Secret** from **Basic Information**
6. Add all three values to your `.env` file

### `ach init agent`

Creates a Claude Managed Agent and Environment via the Anthropic API, or validates existing IDs.

```bash
# Interactive mode
ach init agent

# Non-interactive with existing IDs
ach init agent --agent-id agent_abc123 --environment-id env_xyz789

# Non-interactive — creates new agent and environment
ach init agent --anthropic-api-key sk-ant-... --non-interactive
```

Options:
- `--anthropic-api-key <key>` — Anthropic API key (overrides env/`.env`)
- `--agent-id <id>` — Existing agent ID to validate
- `--environment-id <id>` — Existing environment ID to validate
- `--non-interactive` — Skip prompts (use defaults or provided IDs)

The wizard writes `CLAUDE_AGENT_ID` and `CLAUDE_ENVIRONMENT_ID` to `.env`.

### `ach serve`

Starts the Socket Mode bot server that bridges Slack messages to Claude Managed Agent sessions.

```bash
# Using .env / environment variables
ach serve

# With explicit flags
ach serve --anthropic-api-key sk-ant-... --slack-bot-token xoxb-...
```

Options:
- `--anthropic-api-key <key>`
- `--agent-id <id>`
- `--environment-id <id>`
- `--slack-bot-token <token>`
- `--slack-app-token <token>`
- `--slack-signing-secret <secret>`

The server:
- Connects to Slack via **Socket Mode** (no public URL required)
- Listens for **@mentions** in channels and **direct messages**
- Creates a new Claude agent session per Slack thread
- Streams agent responses back to the thread in real time
- Handles multi-turn conversations within the same thread

Press `Ctrl+C` to stop.

## Architecture

agentchannels uses a **channel adapter pattern** for extensibility:

```
src/
├── cli/                    # CLI entry point (commander)
├── commands/               # Command implementations
│   ├── serve.ts            # ach serve
│   └── init-agent.ts       # ach init agent
├── channels/
│   └── slack/              # Slack channel adapter
│       ├── adapter.ts      # ChannelAdapter implementation
│       ├── init.ts         # ach init slack wizard
│       ├── manifest.ts     # Slack app manifest builder
│       └── api.ts          # Slack API helpers
├── config/
│   ├── schema.ts           # Zod validation schemas
│   └── env.ts              # .env file read/write utilities
└── core/
    ├── channel-adapter.ts  # ChannelAdapter interface
    ├── agent-client.ts     # Anthropic Managed Agent SDK wrapper
    ├── session-manager.ts  # Thread → session mapping (in-memory)
    └── config.ts           # Config resolution (env + flags + .env)
```

### Adding a New Channel

To add support for a new messaging platform (e.g., Discord):

1. Create `src/channels/discord/adapter.ts` implementing the `ChannelAdapter` interface
2. Create `src/channels/discord/init.ts` for the setup wizard
3. Register the new init command in `src/cli/index.ts`
4. Add the channel's config schema to `src/config/schema.ts`

The `ChannelAdapter` interface requires:
- `connect()` / `disconnect()` — lifecycle management
- `onMessage(handler)` — register message handlers
- `sendMessage(channelId, threadId, text)` — send a complete message
- `startStream(channelId, threadId)` — start a streaming response (returns a `StreamHandle`)

## Development

```bash
# Install dependencies
pnpm install

# Run in dev mode (tsx, no build needed)
pnpm dev -- serve

# Build
pnpm build

# Run tests
pnpm test

# Run tests in watch mode
pnpm test:watch
```

### Project Conventions

- **TypeScript** with strict mode
- **ES Modules** (`"type": "module"`)
- **pnpm** as package manager
- **Vitest** for testing
- **Zod** for runtime validation

## Design Decisions

| Decision | Rationale |
|---|---|
| **Socket Mode** | No public URL or ngrok required — works behind firewalls |
| **Thread = Session** | Natural mapping: each Slack thread is one multi-turn agent conversation |
| **In-memory sessions** | Simple, stateless design; sessions restart if the server restarts |
| **Streaming responses** | Uses Slack's experimental `chat.startStream()` for real-time output |
| **Adapter pattern** | Adding Discord/Teams requires only implementing one interface |
| **Single workspace** | One `ach serve` instance per Slack workspace (no multi-tenant complexity) |

## Troubleshooting

### "ANTHROPIC_API_KEY is required"
Ensure your API key is set in `.env`, as an environment variable, or via `--anthropic-api-key`.

### "Must be a valid Slack bot token (xoxb-...)"
The bot token must start with `xoxb-`. Run `ach init slack` to generate one, or check your Slack app's **OAuth & Permissions** page.

### "Must be a valid Slack app-level token (xapp-...)"
The app token must start with `xapp-`. Generate one under your Slack app's **Basic Information** → **App-Level Tokens** with the `connections:write` scope.

### Bot doesn't respond to messages
1. Verify the bot is invited to the channel (`/invite @YourBot`)
2. Check that **Socket Mode** is enabled in your Slack app settings
3. Ensure `app_mention` and `message.im` events are subscribed
4. Check the server logs for errors

### Session lost after server restart
Sessions are stored in-memory only. Restarting `ach serve` clears all session mappings. Users can start a new thread to begin a fresh conversation.

## License

[Apache 2.0](LICENSE)
