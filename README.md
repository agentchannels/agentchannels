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

Set up a [Claude Managed Agent](https://platform.claude.com/docs/en/managed-agents/quickstart) on Slack in three commands:

```bash
# Install
brew install agentchannels/tap/ach

# Set up agent, environment, vault, and Slack app — one interactive wizard
ach init slack

# Start the bot
ach serve
```

That's it. `ach init slack` selects or creates your Claude Managed Agent and Environment, optionally links a Vault, configures your Slack app, and writes everything to `.env`. Then `ach serve` picks it all up automatically.

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

The `ach init slack` wizard (or `/agentchannels:init-slack` in Claude Code) writes these to `.env` automatically — you shouldn't need to edit this file by hand.

## CLI Reference

### `ach init slack`

Interactive wizard that handles **complete setup** in one flow:

1. **Anthropic API key** — validated up front; invalid keys re-prompt instead of crashing the wizard
2. **Claude Managed Agent** — pick from the list, create a new one, or paste an existing agent ID
3. **Environment** — pick from the list, create a new one, or paste an existing environment ID
4. **Vaults** *(optional)* — multi-select from the list, paste comma-separated IDs, or skip (provides MCP OAuth credentials to sessions)
5. **Slack app** — three modes: **automatic** (creates the app via the Slack API), **guided** (walks you through api.slack.com), or **manual** (paste tokens you already have)

Smart about existing state: if `.env` already contains `CLAUDE_AGENT_ID` / `CLAUDE_ENVIRONMENT_ID` / `CLAUDE_VAULT_IDS`, each is validated against the API and offered for reuse. Stale IDs (agent deleted since last run, invalid vault) are flagged and you're re-prompted only for the affected slots. When your account has no agents or environments yet, the wizard jumps straight to the create flow.

All IDs and tokens are written to `.env`. After running this command, `ach serve` needs no flags.

**Non-interactive mode** (CI / scripting):

```bash
ach init slack --non-interactive \
  --anthropic-api-key sk-ant-... \
  --claude-agent-id agent_... \
  --claude-environment-id env_... \
  --claude-vault-ids vault_a,vault_b \
  --slack-bot-token xoxb-... \
  --slack-app-token xapp-... \
  --slack-signing-secret ...
```

Every ID is validated silently. If any required value is missing or invalid, the command exits non-zero and names the failing field.

### `ach serve`

Starts the bot. Connects to Slack via Socket Mode (no public URL needed), listens for @mentions and DMs, creates agent sessions per thread, streams responses back. Press `Ctrl+C` to stop.

## Use from Claude Code

Once the [Claude Code plugin](#installation) is installed, two slash commands are available. They wrap the CLI but let Claude gather your credentials conversationally — no terminal takeover, no remembering flags.

### `/agentchannels:init-slack`

Walks you through complete setup — agent, environment, vault, and Slack app — in one conversation. The wizard:

1. Validates your `ANTHROPIC_API_KEY` first so Slack setup never happens against a broken agent.
2. Lists your Claude Managed Agents; lets you pick one or create a new one.
3. Lists your Claude Environments; lets you pick one or create a new one.
4. Optionally selects a Vault for MCP OAuth credentials.
5. Handles Slack app creation — Claude asks which path you want:
   - **Automatic** — you paste a Slack Refresh Token (`xoxe-...`); Claude runs `ach init slack --non-interactive --slack-refresh-token ...`, which creates the app via the Slack API and opens your browser for workspace install.
   - **Manual** — you already have bot token, app token, and signing secret; Claude passes them as inline env vars to `ach init slack --non-interactive` so they don't appear in `ps`.

Writes all IDs and credentials to `.env` on success.

### `/agentchannels:serve`

Verifies `CLAUDE_AGENT_ID` and `CLAUDE_ENVIRONMENT_ID` are set, then launches `ach serve` in the background so the bridge keeps running while you keep using Claude Code. Claude can check whether the process is still alive via `ps`.

> **Prereq**: Make sure you've run `/agentchannels:init-slack` first — it creates your Claude Managed Agent, Environment, and Slack credentials in one flow and writes all IDs to `.env`.

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
