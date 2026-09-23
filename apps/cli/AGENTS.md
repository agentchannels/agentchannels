# AgentChannels CLI

The installed product: the `agentchannels` command, its local daemon, SQLite
state, Git worktrees, the Claude runtime adapter, and Slack and Linear connector
semantics. It ships as one compiled binary per platform.

## Invariants

- Keep the core `Agent`, `Binding`, `Session`, and `Interaction` model runtime-neutral. Claude-specific types and behavior belong in the runtime adapter.
- Connector credentials and private installation keys belong in the operating-system credential store. Never write them to SQLite or logs.
- Derive the whole installation namespace, including the credential-store service name, from one product home. `--home` must isolate secrets as completely as it isolates SQLite.
- Treat Session execution, channel delivery, and relay transport as independent failure domains. A delivery failure must not turn successful execution into a failed Session.
- Answer a forwarded webhook from local state only. The Relay drops an event whose local answer misses its response budget and never retries, so credential-store reads, provider token refreshes, and worktree creation belong off that path.
- Acknowledge an accepted Session on the channel before creating its worktree. Providers expect a first activity within seconds of the originating event.
- Create Git Session worktrees from the repository's current `HEAD`. Never copy the operator's uncommitted working tree into a Session.
- Delete only worktrees that AgentChannels owns and has verified are clean. Preserve dirty or unowned worktrees.
- New runtime permission decisions are operator-only. Shared users may work in Sessions but may not expand runtime authority.
- A permission reply the runtime cannot read must leave the interaction pending and ask again. Settling it as a denial tells the operator nothing and looks identical to being ignored.
- Agent-scoped runtime state is opaque outside the runtime that wrote it. A Claude permission rule has no counterpart in another runtime, so the store, the engine, and the connectors persist and pass the blob without reading it.
- Never pass `settingSources`, `env`, or `mcpServers` to the Claude SDK. Omitting them is what makes a Session inherit the operator's real CLAUDE.md, skills, MCP servers, and secrets, and one added key would end that silently. `settings` is a separate additive layer and is the one exception.
- Run the operator's installed `claude` through `pathToClaudeCodeExecutable`. The SDK's own lookup cannot find its bundled binary inside a compiled executable, and the product's premise is the operator's existing Claude Code.
- Verify Slack and Linear signatures locally from the original raw request body and headers before dispatching work.
- Persist follow-ups that arrive during an active runtime turn and deliver them in order after that turn. Do not steer the active turn implicitly.
- Preserve crash recovery metadata and require an intentional follow-up before resuming interrupted work.
- Keep one canonical Relay HTTP(S) origin per installation. Derive enrollment, webhook, and WebSocket endpoints with URL semantics; never add transient command or environment overrides.
- Enroll a replacement Relay before persisting a cutover, preserve all local state, and require Binding reconfiguration acknowledgment. Never fall back to hosted implicitly or hot-reload a running daemon.
- Keep schema migrations numbered, forward-only, and transactional. Refuse newer schemas and create an operator-only SQLite backup with `VACUUM INTO` before every persistent migration; rollback is `agentchannels database restore` and never runs a down-migration.
- Suspend foreign-key enforcement while migrating and verify `foreign_key_check` before committing. A migration that rebuilds a table drops the original, and with enforcement on that fires `ON DELETE CASCADE` and silently removes dependent rows.
- Connector and runtime identifiers are opaque. Constrain their shape (`^[a-z][a-z0-9_-]{0,31}$`), never their value, in types, SQLite, and the wire protocol alike. Adding a provider or a runtime is one new file and one registry entry, never a relay release.
- Enrollment authorization is request-only input. Never accept it as a normal argument or persist it in SQLite, the credential store, logs, or output.
- `bun:sqlite` counts rows removed by `ON DELETE CASCADE` in `changes`. Test a delete by `changes > 0`, never `=== 1`.

## Structure

Three directories are extension points with one shape: a contract plus one file
per case. `src/connectors` holds channel providers, registered in
`src/connectors/registry.ts`; `src/runtimes` holds agent runtimes, registered in
`src/runtimes/contract.ts`; `src/service` holds background-service platforms.
Registries are static because a compiled binary has no directory to scan.

`src/model.ts` is the leaf of the graph and imports only
`@agentchannels/protocol`. `src/engine` orchestrates Sessions and knows only
contracts. `src/store` owns SQLite, `src/relay` owns the relay client, `src/cli`
owns the terminal, and `src/daemon.ts` is the composition root. `biome.json`
enforces these directions and forbids importing the relay app.

## Compatibility surfaces

- CLI commands, flags, exit behavior, and `--json` output
- SQLite migrations and persisted status values
- runtime and connector interfaces
- Slack and Linear webhook parsing and delivery payloads

## Commands

```sh
bun run --filter agentchannels dev -- status
bun run --filter agentchannels dev:daemon
bun run --filter agentchannels test
bun run --filter agentchannels build
```

`dev` points `AGENTCHANNELS_HOME` at a gitignored `.dev/` directory, which also
selects a separate credential-store namespace, so development can never read or
delete the operator's real secrets.

Shared temporary homes, Git repositories, in-memory credential stores, and the
compiled-binary fixture live in `test/helpers/fixtures.ts`. Build new fixtures
there. Behavior changes extend the closest focused test; security, recovery,
ordering, worktree, and delivery changes need a regression test at the
invariant. Use real SQLite and Git where the existing tests do.
