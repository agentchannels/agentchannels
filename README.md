# AgentChannels

AgentChannels lets people use an existing local Claude Code environment from Slack or Linear.

## How it works

Slack and Linear send webhooks through an AgentChannels Relay to the local daemon. The daemon verifies provider signatures and access, creates an isolated Git worktree from the repository's current `HEAD`, runs Claude Code, and sends results back to the originating conversation.

Connector credentials and the installation private key are stored in the operating-system credential store. Uncommitted changes in the operator's working tree are not copied into remote Sessions.

## Requirements

- Node.js 22 or newer
- pnpm
- A Git repository with a current `HEAD`
- Local Claude Code authentication and configuration
- A reachable Relay endpoint when self-hosting
- Slack or Linear workspace administrator access for application setup

## Install from source

```sh
pnpm install --frozen-lockfile
pnpm start -- init
```

## Quick start

Initialize an Agent from the repository Claude should use:

```sh
cd /path/to/repository
agentchannels init
```

`init` detects the Git repository and Claude Code runtime, proposes the
repository name, lets you select Slack and/or Linear, writes the provider
manifest to `~/.agentchannels/onboarding`, opens the administrator page when a
browser is available, verifies hidden credential input, discovers the
workspace and Operator, activates the Binding, and offers to install the
per-user background daemon. Rerun the same command after cancellation or a
provider error to resume the saved step.

Fresh installations use `https://relay.agentchannels.io` without asking a
Relay question. A local-only init does not enroll or create Relay state.

To use a self-hosted Relay for the whole installation, select it before creating
Bindings. The token is read from standard input and is not stored:

```sh
agentchannels relay use \
  --url https://relay.example.com \
  --enrollment-token-stdin < /secure/path/relay-enrollment-token
```

Low-level automation can still complete a prepared setup explicitly:

```sh
agentchannels binding complete \
  --setup bd_... \
  --operator-user PLATFORM_USER_ID \
  --external-installation PLATFORM_WORKSPACE_ID \
  --credentials-stdin < /secure/path/connector-credentials.json
```

Slack credentials contain `signingSecret` and `botToken`. Linear credentials
contain `clientId`, `clientSecret`, and `webhookSecret`; AgentChannels obtains
and verifies the app-actor token using Linear's client-credentials grant.

Run the local daemon:

```sh
agentchannels daemon
```

## Essential commands

- `agentchannels init` creates an Agent for a local Git repository.
- `agentchannels connect <slack|linear>` prepares provider onboarding.
- `agentchannels agent|binding|sessions list` provides global discovery.
- `agentchannels relay use|status` selects or inspects the installation Relay.
- `agentchannels binding complete` stores credentials and activates a Binding.
- `agentchannels access add|list|remove` manages per-Binding access.
- `agentchannels users search <query>` finds stable provider user IDs.
- `agentchannels status` shows global Agent, Binding, setup, and Session state.
- `agentchannels sessions retire` safely retires a retained Session.
- `agentchannels daemon` runs in the foreground; `daemon install|start|stop|status|uninstall`
  manages a macOS LaunchAgent or Linux systemd user service.

Add `--json` to supported commands for machine-readable output. Use `--agent ag_...` when the current directory does not identify one Agent.

## Restore a migration backup

Stop the daemon before restoring. Backup filenames identify the AgentChannels
version, source schema, and creation time. The restore command preserves the
current database and requires explicit acknowledgment that newer state may be
lost:

```sh
node scripts/restore-database.mjs \
  --database ~/.agentchannels/agentchannels.db \
  --backup ~/.agentchannels/backups/agentchannels-v1.0.0-schema-1-TIMESTAMP.db \
  --acknowledge-post-backup-data-loss
```

## Development

```sh
pnpm check
```
