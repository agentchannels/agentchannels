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
pnpm build
pnpm link --global
```

## Quick start

Initialize an Agent from the repository Claude should use:

```sh
cd /path/to/repository
agentchannels init
```

Prepare a Slack Binding and app manifest. A fresh installation enrolls with the
hosted Relay automatically:

```sh
agentchannels --json connect slack --agent ag_...
```

For Linear, use `connect linear` and also provide `--linear-client-url` and `--linear-redirect-url`.

To use a self-hosted Relay for the whole installation, select it before creating
Bindings. The token is read from standard input and is not stored:

```sh
agentchannels relay use \
  --url https://relay.example.com \
  --enrollment-token-stdin < /secure/path/relay-enrollment-token
```

After installing the provider application, place its credentials in an operator-only file and pass them over standard input:

```sh
agentchannels binding complete \
  --setup bd_... \
  --operator-user PLATFORM_USER_ID \
  --external-installation PLATFORM_WORKSPACE_ID \
  --credentials-stdin < /secure/path/connector-credentials.json
```

Slack credentials contain `signingSecret` and `botToken`. Linear credentials contain `webhookSecret` plus either an app-actor `apiToken` or `clientId` and `clientSecret`.

Run the local daemon:

```sh
agentchannels daemon
```

## Essential commands

- `agentchannels init` creates an Agent for a local Git repository.
- `agentchannels connect <slack|linear>` prepares provider onboarding.
- `agentchannels relay use|status` selects or inspects the installation Relay.
- `agentchannels binding complete` stores credentials and activates a Binding.
- `agentchannels access add|list|remove` manages per-Binding access.
- `agentchannels users search <query>` finds stable provider user IDs.
- `agentchannels status` shows Agent, Binding, setup, and Session state.
- `agentchannels sessions retire` safely retires a retained Session.
- `agentchannels daemon` runs the local relay connection and workers.

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
