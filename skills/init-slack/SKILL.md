# /ach:init-slack

Initialize a complete agentchannels stack — Claude Managed Agent, Environment, optional Vault IDs, and Slack bot — by collecting credentials conversationally and writing them to `.env`.

## Overview

This skill guides the user through the full agentchannels setup in five phases:

1. **API Key** — Validate `ANTHROPIC_API_KEY` against the Anthropic API
2. **Agent** — Select an existing Claude Managed Agent or create a new one
3. **Environment** — Select an existing Claude Environment or create a new one
4. **Vaults** — Optionally attach Vault IDs for MCP OAuth credentials (skippable)
5. **Slack** — Configure the Slack bot (bot token, app token, signing secret)

All five phases complete before anything is written to `.env`. If any phase fails, the user stays in that phase until it succeeds or they abort.

> **Why this order?** Agent and environment validation require a live API key. Validating these before Slack setup means users never configure Slack only to discover their agent is broken — the failure is surfaced immediately.

---

## Pre-flight — Read existing `.env`

Before asking any questions, use the Read tool to check for an existing `.env` file in the current working directory. Extract these values if present:

- `ANTHROPIC_API_KEY`
- `CLAUDE_AGENT_ID`
- `CLAUDE_ENVIRONMENT_ID`
- `CLAUDE_VAULT_IDS`
- `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_REFRESH_TOKEN`

Store them as defaults for the steps that follow. **Never echo raw token or key values back to the user** — show only the prefix (e.g., `sk-ant-...` confirmed) or confirm the last four characters.

---

## Phase 1 — API Key

### 1a. Check existing key

If `ANTHROPIC_API_KEY` is already set in `.env` or the current environment, inform the user and validate it immediately (see **1b**):

> "I found an existing `ANTHROPIC_API_KEY` (ending `...{last4}`) in `.env`. Validating it now..."

If no key is found:

> "To get started, I need your Anthropic API key. You can find it at https://console.anthropic.com/keys (starts with `sk-ant-`).
>
> Please paste it when prompted — it will not be displayed."

Collect it without echoing (treat like a password field).

### 1b. Validate the key

Run the following Bash command to validate the key by listing agents as a lightweight health check:

```bash
ANTHROPIC_API_KEY='<key>' node --input-type=module <<'EOF'
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
try {
  await client.beta.agents.list({ limit: 1 });
  console.log('VALID');
} catch (e) {
  console.log('INVALID:' + e.message);
}
EOF
```

- **Output `VALID`**: proceed to Phase 2.
- **Output starts with `INVALID:`**: show the error message and re-prompt for the key. Do not proceed until the key validates successfully.
- **Node/SDK failure**: inform the user and ask them to confirm the key is correct before proceeding.

---

## Phase 2 — Agent

### 2a. Check existing agent ID

If `CLAUDE_AGENT_ID` is found in `.env`, validate it immediately:

> "Found `CLAUDE_AGENT_ID=<id>` in `.env`. Validating it..."

```bash
ANTHROPIC_API_KEY='<key>' node --input-type=module <<'EOF'
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
try {
  const agent = await client.beta.agents.retrieve('<agent_id>');
  console.log(JSON.stringify({ id: agent.id, name: agent.name }));
} catch (e) {
  console.log('ERROR:' + e.message);
}
EOF
```

- **Valid response**: Confirm (`✅ Agent "<name>" (<id>) is accessible`) and ask whether to keep it or choose a different one.
  - **Keep it**: proceed to Phase 3 with this agent ID.
  - **Choose differently**: continue to **2b**.
- **Error / not found**: Warn the user explicitly — do not silently drop the stale value:
  > ⚠️ The agent ID in your `.env` (`<id>`) is no longer accessible (stale). You'll need to select or create a replacement.

  Then continue to **2b**.

### 2b. List available agents

```bash
ANTHROPIC_API_KEY='<key>' node --input-type=module <<'EOF'
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
try {
  const response = await client.beta.agents.list({ limit: 20 });
  const data = response.data ?? response;
  console.log(JSON.stringify(Array.isArray(data)
    ? data.map(a => ({ id: a.id, name: a.name }))
    : []));
} catch (e) {
  console.log('ERROR:' + e.message);
}
EOF
```

**If the list is empty** or returns an error, skip selection and jump directly to **2c** (create). Do not show a blank menu.

**If agents exist**, present them with a final "Create a new agent" option:

> "Here are your existing Claude Managed Agents:
>
> 1. `<name>` (`<id>`)
> 2. `<name>` (`<id>`)
> ...
> N. **Create a new agent**
>
> Which would you like to use?"

### 2c. Create a new agent

Ask:

1. **Name** — default: `agentchannels-bot`
2. **Description** (optional — press Enter to skip)
3. **System prompt** (optional — can be configured later in the Anthropic Console)
4. **Model** (optional — press Enter to use the API default, e.g. `claude-opus-4-5`)

Then create:

```bash
ANTHROPIC_API_KEY='<key>' node --input-type=module <<'EOF'
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
try {
  const params = { name: '<name>' };
  if ('<model>') params.model = '<model>';
  if ('<description>') params.description = '<description>';
  if ('<system>') params.system = '<system>';
  const agent = await client.beta.agents.create(params);
  console.log(JSON.stringify({ id: agent.id, name: agent.name }));
} catch (e) {
  console.log('ERROR:' + e.message);
}
EOF
```

- **Success**: confirm (`✅ Agent "<name>" created — ID: <id>`) and proceed to Phase 3.
- **Error**: show the message and re-prompt. Do not proceed until an agent is resolved.

---

## Phase 3 — Environment

Agents and environments are independent top-level resources. The environment does not need to share a name with the agent, though a matching suffix (e.g., `agentchannels-bot-env`) is a helpful convention.

### 3a. Check existing environment ID

If `CLAUDE_ENVIRONMENT_ID` is found in `.env`, validate it:

> "Found `CLAUDE_ENVIRONMENT_ID=<id>` in `.env`. Validating it..."

```bash
ANTHROPIC_API_KEY='<key>' node --input-type=module <<'EOF'
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
try {
  const env = await client.beta.environments.retrieve('<env_id>');
  console.log(JSON.stringify({ id: env.id, name: env.name }));
} catch (e) {
  console.log('ERROR:' + e.message);
}
EOF
```

- **Valid**: Confirm and offer to keep it or choose a different one.
- **Error / not found**: Warn explicitly (stale state) and continue to **3b**. Never silently discard the stale ID without warning.

### 3b. List available environments

```bash
ANTHROPIC_API_KEY='<key>' node --input-type=module <<'EOF'
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
try {
  const response = await client.beta.environments.list({ limit: 20 });
  const data = response.data ?? response;
  console.log(JSON.stringify(Array.isArray(data)
    ? data.map(e => ({ id: e.id, name: e.name }))
    : []));
} catch (e) {
  console.log('ERROR:' + e.message);
}
EOF
```

**If the list is empty**, skip to **3c** (create). **If environments exist**, present them with a "Create a new environment" option.

### 3c. Create a new environment

Ask:

1. **Name** — default: `<agent-name>-env`
2. **Description** (optional)

```bash
ANTHROPIC_API_KEY='<key>' node --input-type=module <<'EOF'
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
try {
  const params = { name: '<name>' };
  if ('<description>') params.description = '<description>';
  const env = await client.beta.environments.create(params);
  console.log(JSON.stringify({ id: env.id, name: env.name }));
} catch (e) {
  console.log('ERROR:' + e.message);
}
EOF
```

- **Success**: confirm (`✅ Environment "<name>" created — ID: <id>`) and proceed to Phase 4.
- **Error**: show the message and re-prompt.

---

## Phase 4 — Vaults (optional)

> "Do you have any Vault IDs for MCP tool OAuth credentials? Vaults let the agent access services like Google Drive or GitHub using stored OAuth tokens managed by Anthropic.
>
> Enter vault IDs as a comma-separated list (e.g., `vault_abc123,vault_def456`), or press Enter to skip."

- If `CLAUDE_VAULT_IDS` is already in `.env`, show the existing value as the default and offer to keep or replace it.
- If the user presses Enter without providing values, `CLAUDE_VAULT_IDS` is left unset (omitted from `.env`).

> **Note**: Vault *creation* is out of scope for this wizard. To create a vault, visit the Anthropic Console.

---

## Phase 5 — Slack Setup

### 5a. Determine setup path

> "How would you like to set up your Slack integration?
>
> 1. **Manual** — I already have a Slack Bot Token (`xoxb-...`), App-Level Token (`xapp-...`), and Signing Secret
> 2. **Automatic** — I have a Slack Refresh Token (`xoxe-...`) and want the CLI to create the app for me
>
> Which path would you like to use?"

### 5b. Collect credentials

#### Manual path

Ask for each credential separately and validate the format before proceeding:

1. **Slack Bot Token** — must start with `xoxb-` and be at least 20 characters. Found at: Basic Information → OAuth & Permissions → Bot User OAuth Token on [api.slack.com/apps](https://api.slack.com/apps).

2. **Slack App-Level Token** — must start with `xapp-` and be at least 20 characters. Found at: Basic Information → App-Level Tokens → Generate Token and Scopes (add scope `connections:write`). This token enables Socket Mode (no public URL needed).

3. **Slack Signing Secret** — any non-empty string at least 10 characters. Found at: Basic Information → App Credentials → Signing Secret.

Tell the user: **"Please paste credentials one at a time. Do not include multiple tokens in a single message."**

#### Automatic path

Ask in order:

1. **Slack app name** — display name for the app (default: `"General Agent"`). Confirm before proceeding — renaming later requires visiting api.slack.com/apps.

2. **Slack app description** (optional) — one-line description shown in the workspace app directory.

3. **Slack Refresh Token** — must start with `xoxe-` and be at least 20 characters.
   - To generate: [api.slack.com/apps](https://api.slack.com/apps) → Your Apps → Refresh tokens.
   - Warn: **"⚠️ This will open a browser window for OAuth authorization and may take up to 5 minutes."**
   - Warn: **"⚠️ The refresh token is invalidated after use. The CLI saves the new refresh token to `.env` automatically."**

---

## Phase 6 — Execute the CLI command

Once all phases are complete, call `ach init slack --non-interactive` with **all** collected credentials as inline environment variables. **Never pass credentials as CLI flags** — inline env vars keep them out of process listings.

### Manual path command

```bash
ANTHROPIC_API_KEY='<api_key>' \
CLAUDE_AGENT_ID='<agent_id>' \
CLAUDE_ENVIRONMENT_ID='<env_id>' \
SLACK_BOT_TOKEN='<bot_token>' \
SLACK_APP_TOKEN='<app_token>' \
SLACK_SIGNING_SECRET='<signing_secret>' \
ach init slack --non-interactive
```

With optional vault IDs:

```bash
ANTHROPIC_API_KEY='<api_key>' \
CLAUDE_AGENT_ID='<agent_id>' \
CLAUDE_ENVIRONMENT_ID='<env_id>' \
CLAUDE_VAULT_IDS='<vault_ids>' \
SLACK_BOT_TOKEN='<bot_token>' \
SLACK_APP_TOKEN='<app_token>' \
SLACK_SIGNING_SECRET='<signing_secret>' \
ach init slack --non-interactive
```

### Automatic path command

```bash
ANTHROPIC_API_KEY='<api_key>' \
CLAUDE_AGENT_ID='<agent_id>' \
CLAUDE_ENVIRONMENT_ID='<env_id>' \
SLACK_REFRESH_TOKEN='<refresh_token>' \
ach init slack --non-interactive \
  --app-name '<app_name>' \
  --app-description '<app_description>'
```

With optional vault IDs:

```bash
ANTHROPIC_API_KEY='<api_key>' \
CLAUDE_AGENT_ID='<agent_id>' \
CLAUDE_ENVIRONMENT_ID='<env_id>' \
CLAUDE_VAULT_IDS='<vault_ids>' \
SLACK_REFRESH_TOKEN='<refresh_token>' \
ach init slack --non-interactive \
  --app-name '<app_name>' \
  --app-description '<app_description>'
```

Omit `--app-description` if the user didn't provide one. If no name was supplied, omit `--app-name` too — the CLI defaults to `"General Agent"`.

> **If `ach` is not found in PATH**: try `npx agentchannels init slack --non-interactive` or `./node_modules/.bin/ach init slack --non-interactive` as fallbacks.

---

## Phase 7 — Report results

### On success (exit code 0)

Confirm that all credentials were saved to `.env`:

> ✅ **Setup complete!** The following were written to `.env`:
>
> - `ANTHROPIC_API_KEY` — Anthropic API key confirmed
> - `CLAUDE_AGENT_ID` — Agent: `<name>` (`<id>`)
> - `CLAUDE_ENVIRONMENT_ID` — Environment: `<name>` (`<id>`)
> - `CLAUDE_VAULT_IDS` — `<vault_ids>` _(if provided)_
> - `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET` — Slack credentials
>
> **Next step:** Run `/ach:serve` to start the bridge, or `ach deploy railway` to deploy to Railway.

### On failure (non-zero exit code)

Show the error output and diagnose:

| Error pattern | Remediation |
|---|---|
| Token format error | Re-prompt for the specific credential that failed (return to Phase 5) |
| `ANTHROPIC_API_KEY` invalid | Re-run Phase 1 |
| Agent / environment not found | Re-run Phase 2 or Phase 3 to select a valid ID |
| OAuth timeout (automatic path) | Explain the browser window must be completed within 5 minutes; offer to retry Phase 5 |
| Insufficient credentials | Clarify which tokens are missing and re-prompt |

---

## Edge cases and warnings

- **Existing `.env`**: The CLI automatically backs up the existing `.env` before writing. Inform the user their previous credentials are preserved in `.env.bak`.
- **Stale IDs in `.env`**: If an existing `CLAUDE_AGENT_ID` or `CLAUDE_ENVIRONMENT_ID` is no longer accessible via the API, warn the user explicitly. Never silently overwrite or discard the stale ID without informing the user.
- **Token security**: Never echo raw token or API key values back to the user in plain text. Show only the prefix or final four characters (e.g., `xoxb-...` confirmed, `sk-ant-...` ending `Xk3Q`).
- **Empty agent / environment lists**: If the API returns an empty list, skip selection and jump directly to the create step. Do not render a blank menu.
- **Vault creation out of scope**: Vaults can only be *selected* in this wizard, not created. If the user needs a new vault, direct them to the Anthropic Console before rerunning this skill.
- **Socket Mode requirement**: The Slack app must have Socket Mode enabled. For manual path users who may have missed this: Settings → Socket Mode → Enable Socket Mode. Ensure an App-Level Token with `connections:write` scope exists.
- **Guided Slack path**: The guided path (step-by-step manifest display) is only available via `ach init slack` run directly in a terminal (without `--non-interactive`). If a user wants that experience, instruct them to run `ach init slack` in their terminal instead.
