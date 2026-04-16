# Agent Channels

Agent Channels (`ach`) is a CLI that bridges your communicatino channels, such as Slack, to agents like [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/). Mention the bot in any channel or DM and each thread becomes a multi-turn streaming session with your agent — tools, vaults, and all.

<p align="center">
  <img src="docs/assets/demo.gif" alt="Paperclip — runs your business" width="720" />
</p>

## Agent Channels is right for you if

- ✅ You've built (or want to build) a **Claude Managed Agent** and need to put it in front of a team
- ✅ You want to **build agents once** and provide them across multiple channels
- ✅ You want to **provide your agents to your colleagues through Slack**, without building a separate app for them
- ✅ You **don't want to build messy connectors** between agents and communication channels yourself
- ✅ You want **multi-turn conversations** per thread, not one-shot Q&A bots
- ✅ You want **streaming responses** that appear in real time, not 30-second waits for a wall of text

## Quick Start

Connect an existing [Claude Managed Agent](https://platform.claude.com/docs/en/managed-agents/quickstart) to Slack:

```bash
# Install
brew install agentchannels/tap/ach

# Set up your Slack app (interactive wizard)
ach init slack

# Start the bot with your agent IDs
ach serve --agent-id agent_... --environment-id env_...
```

That's it. Mention your bot in any Slack channel and start chatting.

> **Don't have an agent yet?** Run `ach init agent` — the wizard will create a new Claude Managed Agent and Environment, then just run `ach serve`.

> **Prefer Claude Code?** Install the plugin (see [Installation](#installation) below), then run `/agentchannels:init-slack` and `/agentchannels:serve` inside Claude Code. Jump to [Use from Claude Code](#use-from-claude-code) for details.

## Installation

<details>
<summary><strong>Claude Code plugin</strong></summary>

Install directly into Claude Code — no git clone needed:

```bash
claude plugin marketplace add agentchannels/agentchannels
claude plugin install agentchannels@agentchannels
```

Then use `/agentchannels:init-slack` and `/agentchannels:serve` inside Claude Code. See [Use from Claude Code](#use-from-claude-code) for what each skill does.

To update: `claude plugin update agentchannels@agentchannels`
</details>

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

| Variable | CLI flag | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | `--anthropic-api-key` | Anthropic API key |
| `CLAUDE_AGENT_ID` | `--agent-id` | Claude Managed Agent ID |
| `CLAUDE_ENVIRONMENT_ID` | `--environment-id` | Claude Environment ID |
| `CLAUDE_VAULT_IDS` | `--vault-ids` | Comma-separated [vault](https://platform.claude.com/docs/en/managed-agents/vaults) IDs for MCP authentication (optional) |
| `SLACK_BOT_TOKEN` | `--slack-bot-token` | Slack bot token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | `--slack-app-token` | Slack app-level token (`xapp-...`) for Socket Mode |

The `ach init slack` and `ach init agent` wizards write these to `.env` automatically — you shouldn't need to edit this file by hand.

## CLI Reference

### `ach init slack`

Interactive wizard that creates a Slack app with the right permissions and generates all required tokens. Three modes: **automatic** (creates the app via API), **guided** (walks you through api.slack.com), or **manual** (paste tokens you already have).

### `ach init agent`

Creates a new Claude Managed Agent and Environment, or validates existing ones. Supports `--non-interactive` mode for CI/scripting. Run `ach init agent --help` for flags.

### `ach serve`

Starts the bot. Connects to Slack via Socket Mode (no public URL needed), listens for @mentions and DMs, creates agent sessions per thread, streams responses back. Press `Ctrl+C` to stop.

## Use from Claude Code

Once the [Claude Code plugin](#installation) is installed, two slash commands are available. They wrap the CLI but let Claude gather your credentials conversationally — no terminal takeover, no remembering flags.

### `/agentchannels:init-slack`

Walks you through Slack app credential setup. Claude asks which path you want:

- **Automatic** — you paste a Slack Refresh Token (`xoxe-...`); Claude runs `ach init slack --non-interactive --slack-refresh-token ...`, which creates the app via the Slack API and opens your browser for workspace install (blocks up to 5 minutes).
- **Manual** — you already have bot token, app token, and signing secret; Claude passes them as inline env vars to `ach init slack --non-interactive` so they don't appear in `ps`.

Writes credentials to `.env` on success. Claude will confirm the Slack app name with you before creating anything.

### `/agentchannels:serve`

Verifies `CLAUDE_AGENT_ID` and `CLAUDE_ENVIRONMENT_ID` are set, then launches `ach serve` in the background so the bridge keeps running while you keep using Claude Code. Claude can check whether the process is still alive via `ps`.

> **Prereq**: Make sure you've run `ach init agent` (interactively) to create your Claude Managed Agent + Environment and written the IDs to `.env`. The `init-agent` skill is not part of v1.

### How the skills work under the hood

The plugin ships two `SKILL.md` files that instruct Claude to (1) gather credentials using `AskUserQuestion`, then (2) invoke the existing CLI via Bash with `--non-interactive`. There is no MCP server — the skills are thin glue over the CLI, so every CLI flag and env var is usable from Claude Code too.

## Deploy

### Railway

```bash
ach deploy railway
```

Interactive wizard that creates a project, pushes your env vars, and deploys the Docker image. Requires a [Railway API token](https://railway.com/account/tokens).

### Docker

```bash
docker run -d \
  --env-file .env \
  ghcr.io/agentchannels/agentchannels:latest
```

### Other platforms

agentchannels uses Socket Mode (WebSocket), so it works anywhere that runs persistent processes — Fly.io, Render, any VPS. Not recommended for serverless (Lambda, Vercel) since agent responses can take 30+ seconds.

## How It Works

```
     ┌─────────────────┐      ┌──────────────────────┐      ┌────────────────────┐
     │                 │      │                      │      │                    │
     │   Slack thread  │◀────▶│   ach serve (you)    │◀────▶│  Claude Managed    │
     │                 │      │                      │      │      Agent         │
     │  @mention       │      │  Socket Mode         │      │                    │
     │  reply in       │─────▶│  listener +          │─────▶│  session per       │
     │    thread       │      │  streaming bridge    │      │    thread          │
     │                 │◀─────│                      │◀─────│  multi-turn        │
     │  user @mention  │      │  channel-agnostic    │      │    memory + tools  │
     │                 │      │  adapter             │      │                    │
     └─────────────────┘      └──────────────────────┘      └────────────────────┘
        WebSocket                 long-lived Node                 Anthropic API
        (no public URL)           process (your host)             (beta sessions)
```

1. A teammate @mentions the bot in Slack — Slack pushes the event over the Socket Mode WebSocket.
2. `ach serve` looks up (or creates) a Claude Managed Agent session keyed on the thread.
3. Your message is sent to the agent; responses stream back token-by-token.
4. `ach` routes each text delta, tool call, and thinking step into Slack's native streaming API so the thread updates live.

## License

[Apache 2.0](LICENSE)
