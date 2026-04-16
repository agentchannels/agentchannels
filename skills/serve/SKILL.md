# /ach:serve

Start the agentchannels bridge server, connecting Slack to Claude Managed Agents via Socket Mode.

## Overview

This skill starts the `ach serve` process in the background. It bridges incoming Slack messages to a Claude Managed Agent session and streams responses back into the Slack thread.

Before starting the server, verify that all required credentials are available by reading the `.env` file in the current directory and checking the current environment. The user must have completed `/ach:init-slack` (which handles agent, environment, and Slack setup in one flow) before running this skill.

## Step 1 — Verify CLAUDE_AGENT_ID and CLAUDE_ENVIRONMENT_ID

Use the Read tool to check the `.env` file in the current directory for the following **required** variables:

| Variable | Description |
|---|---|
| `CLAUDE_AGENT_ID` | Claude Managed Agent ID |
| `CLAUDE_ENVIRONMENT_ID` | Claude Environment ID |

**How to verify:**
1. Read the `.env` file (it is at `.env` relative to the project root, i.e. read `<cwd>/.env`)
2. Check whether `CLAUDE_AGENT_ID` and `CLAUDE_ENVIRONMENT_ID` are both present and non-empty
3. If the `.env` file does not exist, the variables are missing

**If either `CLAUDE_AGENT_ID` or `CLAUDE_ENVIRONMENT_ID` is missing or empty**, stop immediately and respond:

> ❌ **Cannot start the server — missing required configuration:**
>
> - `CLAUDE_AGENT_ID` — [present ✓ / **missing ✗**]
> - `CLAUDE_ENVIRONMENT_ID` — [present ✓ / **missing ✗**]
>
> Please run `/ach:init-slack` to create a Claude Agent, Environment, and Slack credentials. Once that completes, run `/ach:serve` again.

Do not proceed past Step 1 if either variable is missing.

## Step 2 — Verify remaining required credentials

After confirming `CLAUDE_AGENT_ID` and `CLAUDE_ENVIRONMENT_ID` are present, check the `.env` file (already read in Step 1) for these additional required variables:

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key (starts with `sk-ant-`) |
| `SLACK_BOT_TOKEN` | Slack Bot Token (starts with `xoxb-`) |
| `SLACK_APP_TOKEN` | Slack App-Level Token (starts with `xapp-`) |

`SLACK_SIGNING_SECRET` and `CLAUDE_VAULT_IDS` are optional.

If any of the three remaining required variables are missing, stop and inform the user:

> ❌ **Missing additional required configuration:** [list missing variables]
>
> Please run `/ach:init-slack` to configure your Slack credentials, then try again.

## Step 3 — Check for optional configuration

Ask the user if they need any optional settings:

> "Everything looks good — all required credentials are present. Do you need any optional settings before starting?
>
> - **Vault IDs** — comma-separated vault IDs for MCP tool OAuth credentials (e.g., `vault_abc123,vault_def456`)
> - **Credential overrides** — only needed if you want to use different credentials than those in your `.env` file
>
> Press Enter to skip and start now with your `.env` defaults."

If the user has vault IDs or wants to override specific credentials, collect them before proceeding.

## Step 4 — Check for an already-running instance

Before launching, run the following Bash command to detect any existing `ach serve` / `agentchannels` process:

```bash
ps aux | grep -E 'ach serve|agentchannels' | grep -v grep
```

Alternatively, if `pgrep` is available (macOS / most Linux distributions):

```bash
pgrep -la -f 'ach serve|agentchannels' 2>/dev/null || echo "no match"
```

**Interpreting the output:**

| Output | Meaning |
|---|---|
| Empty / `no match` | No bridge process is running — safe to proceed |
| One or more lines containing `ach serve` or `agentchannels serve` | An instance is **already running** |

**If an instance is already running**, stop and ask the user:

> ⚠️ **An agentchannels bridge process appears to already be running:**
>
> ```
> <paste matching ps line(s) here>
> ```
>
> Starting a second instance may cause **duplicate responses** in Slack.
>
> What would you like to do?
> 1. **Kill the existing process and restart** — I'll run `kill <PID>` for you, then start fresh.
> 2. **Keep the existing process** — Skip startup; the bridge is already listening.
> 3. **Start anyway** — Launch a second instance (not recommended).

Obtain the PID from the `ps` output (second column in `ps aux`). If the user chooses option 1, run `kill <PID>` (or `kill -9 <PID>` if the process does not respond), confirm it has stopped by re-running the check command, then proceed to Step 5.

If no running instance is found, proceed directly to Step 5.

## Step 5 — Execute the serve command

Run `ach serve` using the Bash tool. This is a **long-running process** — always use `run_in_background: true` so it does not block the conversation.

### Basic command (uses `.env` for all credentials)

```bash
ach serve
```

### With vault IDs

```bash
CLAUDE_VAULT_IDS='<vault_ids>' ach serve
```

### With credential overrides (inline env vars for security, not visible in `ps`)

```bash
ANTHROPIC_API_KEY='<api_key>' \
CLAUDE_AGENT_ID='<agent_id>' \
CLAUDE_ENVIRONMENT_ID='<env_id>' \
SLACK_BOT_TOKEN='<bot_token>' \
SLACK_APP_TOKEN='<app_token>' \
ach serve
```

> **Note**: If `ach` is not found in PATH (e.g. package not globally installed), try `npx agentchannels serve` or `./node_modules/.bin/ach serve` as fallbacks.

Pass credentials as inline environment variables rather than CLI flags to keep them out of process listings (`ps aux`).

**Always set `run_in_background: true` when executing this Bash command.**

## Step 6 — Confirm startup and monitor output

After launching, watch the initial output lines for confirmation of successful startup:

**Expected success output:**
```
[serve] Starting agentchannels server...
[serve]   Agent:       <agent_id>
[serve]   Environment: <env_id>
[serve] ⚡️ Bolt app is running! (development, socket mode)
[serve] Bot is running. Press Ctrl+C to stop.
```

Report the result to the user:

- **On successful start**: Confirm the server is running and explain that it is listening for Slack messages. Remind them the process runs in the background and can be stopped with Ctrl+C in the terminal or by killing the process.

- **On startup failure (non-zero exit / error in output)**: Show the error and diagnose:
  - `Configuration validation failed` → one or more required env vars are missing; guide the user to run the relevant init command
  - `invalid_auth` or `token_revoked` → Slack tokens are invalid; suggest re-running `/ach:init-slack`
  - `ECONNREFUSED` or network errors → check internet connectivity
  - `CLAUDE_AGENT_ID` / `CLAUDE_ENVIRONMENT_ID` not found → run `/ach:init-slack` first to create the agent and environment

## Edge cases and warnings

- **Already running**: If the user suspects the server is already running (e.g., from a previous session), warn them: running a second instance may cause duplicate responses in Slack. They should kill the existing process before starting a new one.

- **Socket Mode requirement**: `ach serve` uses Slack Socket Mode — no public URL or port forwarding is required. The app token (`xapp-`) enables the WebSocket connection.

- **Session persistence**: Sessions are held in memory only. Restarting the server loses all active Slack conversation sessions, and users will start fresh conversations.

- **Vault IDs**: If the agent uses MCP tools requiring OAuth credentials (e.g., Google Drive, GitHub), pass `CLAUDE_VAULT_IDS` with the appropriate vault IDs. These are created via the Anthropic Console.

- **Graceful shutdown**: The server handles SIGINT and SIGTERM — it aborts in-flight Slack responses cleanly before exiting. Users can stop it safely with Ctrl+C.

- **Railway / production deployment**: For persistent hosting, guide the user to run `ach deploy railway` instead of running `ach serve` locally.
