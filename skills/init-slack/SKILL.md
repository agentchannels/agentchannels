# /ach:init-slack

Initialize Slack integration for agentchannels by collecting credentials conversationally and writing them to `.env`.

## Overview

This skill guides the user through Slack app credential setup for agentchannels. Two paths are supported:

- **Manual path** — User already has all three tokens (bot token, app token, signing secret)
- **Automatic path** — User has a Slack Refresh Token; the CLI creates the app automatically via the Slack API (opens a browser for OAuth, blocks up to 5 minutes)

You will gather the required credentials through conversation, then execute `ach init slack --non-interactive` with those credentials passed as inline environment variables (they are not visible in `ps` output).

## Step 1 — Determine setup path

Ask the user:

> "How would you like to set up your Slack integration?
>
> 1. **Manual** — I already have a Slack Bot Token (`xoxb-...`), App-Level Token (`xapp-...`), and Signing Secret
> 2. **Automatic** — I have a Slack Refresh Token (`xoxe-...`) and want the CLI to create the app for me
>
> Which path would you like to use?"

## Step 2 — Collect credentials

### Manual path (option 1)

Ask for each credential separately and validate the format before proceeding:

1. **Slack Bot Token** — must start with `xoxb-` and be at least 20 characters. If the user is unsure where to find it: Basic Information → OAuth & Permissions → Bot User OAuth Token on [api.slack.com/apps](https://api.slack.com/apps).

2. **Slack App-Level Token** — must start with `xapp-` and be at least 20 characters. If the user needs to create one: Basic Information → App-Level Tokens → Generate Token and Scopes (add scope `connections:write`). This token enables Socket Mode (no public URL needed).

3. **Slack Signing Secret** — any non-empty string at least 10 characters. Found at: Basic Information → App Credentials → Signing Secret.

Tell the user: **"Please paste your credentials one at a time. Do not include them in a single message — enter each token when prompted."**

### Automatic path (option 2)

Ask for these items in order:

1. **Slack app name** — the display name of the app that will be created in the workspace (e.g., "Acme Assistant", "Support Bot"). Default is **"General Agent"** if the user doesn't specify one. Confirm the name with the user before proceeding — the app is created with this name and renaming later requires visiting api.slack.com/apps.

2. **Slack app description** (optional) — one-line description shown in the workspace app directory. Skip if the user doesn't provide one.

3. **Slack Refresh Token** — must start with `xoxe-` and be at least 20 characters.
   - To generate one: go to [api.slack.com/apps](https://api.slack.com/apps) → Your Apps → Refresh tokens
   - Warn the user: **"⚠️ The automatic path will open a browser window for OAuth authorization and may take up to 5 minutes. The CLI will block while waiting for the OAuth callback."**
   - Warn the user: **"⚠️ The existing refresh token will be invalidated after use. The CLI will save the new refresh token to `.env` automatically."**

## Step 3 — Execute the CLI command

Once credentials are collected, execute the appropriate command using Bash. **Pass credentials as inline environment variables, not as CLI flags**, to keep them out of process listings.

### Manual path command

```bash
SLACK_BOT_TOKEN='<bot_token>' \
SLACK_APP_TOKEN='<app_token>' \
SLACK_SIGNING_SECRET='<signing_secret>' \
ach init slack --non-interactive
```

### Automatic path command

Pass the app name (and description if provided) as CLI flags. Only the refresh token is sensitive and goes as an inline env var.

```bash
SLACK_REFRESH_TOKEN='<refresh_token>' \
ach init slack --non-interactive \
  --app-name '<app_name>' \
  --app-description '<app_description>'
```

Omit `--app-description` if the user didn't provide one. If no name was supplied, omit `--app-name` too — the CLI defaults to **"General Agent"**, but always confirm this default with the user before running.

> **Note**: If `ach` is not found in PATH (e.g. package not globally installed), try `npx agentchannels init slack --non-interactive` or `./node_modules/.bin/ach init slack --non-interactive` as fallbacks.

## Step 4 — Report results

After the command completes:

- **On success (exit code 0)**: Confirm that credentials were saved to `.env` and suggest the next step: run `/ach:serve` to start the bridge, or `ach init agent` first if the Claude agent hasn't been configured yet.

- **On failure (non-zero exit code)**:
  - Show the error output from the CLI
  - For token format errors, ask the user to re-enter the specific credential that failed
  - For OAuth timeout (automatic path), explain that the browser window must be completed within 5 minutes and offer to retry
  - For "insufficient credentials" errors, clarify which tokens are missing

## Edge cases and warnings

- **Existing `.env`**: The CLI automatically backs up the existing `.env` before writing. Inform the user their previous credentials are preserved in a `.env.bak` file.
- **Token security**: Never echo credential values back to the user in plain text. If you need to confirm a token was received, show only the prefix (e.g., `xoxb-...` confirmed).
- **Socket Mode requirement**: The Slack app must have Socket Mode enabled. For manual path users who may have missed this, remind them: Settings → Socket Mode → Enable Socket Mode, and ensure an App-Level Token with `connections:write` scope exists.
- **Guided path not available**: The guided path (step-by-step Slack app creation with manifest display) is only available in the interactive CLI (`ach init slack` without `--non-interactive`). If a user wants the guided experience, instruct them to run `ach init slack` directly in their terminal.
