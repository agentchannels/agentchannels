# agentchannels

**Chat with Claude agents in Slack.**

Your team talks to a [Claude Managed Agent](https://platform.claude.com/docs/en/managed-agents/) through Slack threads — each thread is a conversation, responses stream back in real time.

<!-- TODO: Add screenshot/GIF of a Slack thread conversation with the bot -->

## Why

- **Team access** — your whole team can talk to your Claude agent through Slack, no API keys needed per person
- **Threads = conversations** — each Slack thread maps to one agent session with full multi-turn context
- **Streaming** — responses appear in real time, not a 30-second wait for a wall of text
- **3 commands** to go from zero to a running bot

## Quick Start

```bash
# Install
brew install agentchannels/tap/ach

# Set up your Slack app (interactive wizard)
ach init slack

# Create a Claude Managed Agent or connect an existing one
ach init agent

# Start the bot
ach serve
```

That's it. Mention your bot in any Slack channel and start chatting.

> **Already have an agent?** If you created one via the [Managed Agents quickstart](https://platform.claude.com/docs/en/managed-agents/quickstart) using the `ant` CLI or SDK, just pass your IDs directly:
> ```bash
> ach init agent --agent-id agent_... --environment-id env_...
> ```

## Installation

<details>
<summary><strong>macOS (Homebrew)</strong></summary>

```bash
brew install agentchannels/tap/ach
```
</details>

<details>
<summary><strong>npm</strong></summary>

```bash
npm install -g agentchannels
```

Requires Node.js >= 18.
</details>

<details>
<summary><strong>npx (no install)</strong></summary>

```bash
npx agentchannels init slack
npx agentchannels init agent
npx agentchannels serve
```

Requires Node.js >= 18.
</details>

<details>
<summary><strong>From source</strong></summary>

```bash
git clone https://github.com/anthropics/agentchannels.git
cd agentchannels
pnpm install && pnpm build
pnpm link --global
```
</details>

## Prerequisites

- **Anthropic API key** with Managed Agents access — [console.anthropic.com](https://console.anthropic.com/)
- **Slack workspace** where you can create apps

## Configuration

All config can be provided via **environment variables**, a **`.env` file**, or **CLI flags** (highest priority wins).

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `CLAUDE_AGENT_ID` | Claude Managed Agent ID |
| `CLAUDE_ENVIRONMENT_ID` | Claude Environment ID |
| `CLAUDE_VAULT_IDS` | Comma-separated [vault](https://platform.claude.com/docs/en/managed-agents/vaults) IDs for MCP authentication (optional) |
| `SLACK_BOT_TOKEN` | Slack bot token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | Slack app-level token (`xapp-...`) for Socket Mode |
| `SLACK_SIGNING_SECRET` | Slack signing secret |

The `ach init slack` and `ach init agent` wizards write these to `.env` automatically — you shouldn't need to edit this file by hand.

## CLI Reference

### `ach init slack`

Interactive wizard that creates a Slack app with the right permissions and generates all required tokens. Three modes: **automatic** (creates the app via API), **guided** (walks you through api.slack.com), or **manual** (paste tokens you already have).

### `ach init agent`

Creates a new Claude Managed Agent and Environment, or validates existing ones. Supports `--non-interactive` mode for CI/scripting. Run `ach init agent --help` for flags.

### `ach serve`

Starts the bot. Connects to Slack via Socket Mode (no public URL needed), listens for @mentions and DMs, creates agent sessions per thread, streams responses back. Press `Ctrl+C` to stop.

### `ach deploy railway`

Deploys to [Railway](https://railway.com) with an interactive wizard — creates a project, pushes your env vars, and deploys the Docker image. Requires a [Railway API token](https://railway.com/account/tokens).

## Deploy

### Docker

```bash
docker run -d \
  --env-file .env \
  ghcr.io/agentchannels/agentchannels:latest
```

### Other platforms

agentchannels uses Socket Mode (WebSocket), so it works anywhere that runs persistent processes — Railway, Fly.io, Render, any VPS. Not recommended for serverless (Lambda, Vercel) since agent responses can take 30+ seconds.

## How It Works

```
Slack thread  -->  agentchannels (ach serve)  -->  Claude Managed Agent
  @mention          Socket Mode listener            session per thread
  reply in thread   <-- streaming response <--      multi-turn memory
```

## License

[Apache 2.0](LICENSE)
