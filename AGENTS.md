# AgentChannels contributor instructions

## Purpose and boundary

This repository is the user-installed AgentChannels product: its CLI, local daemon, SQLite state, Git worktrees, Claude runtime adapter, and Slack/Linear connector semantics. The separate `agentchannels-relay` repository is transport only.

Use the existing TypeScript, Node.js 22+, and pnpm toolchain.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm dev -- status      # run the CLI from source against an isolated .dev/ home
pnpm dev:daemon         # run the daemon from source, restarting on change
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm check
```

Development runs the TypeScript sources directly through Node's built-in type
stripping, so there is no build step in the edit/run loop and `dist/` can never
go stale. That requires Node.js 24 locally; the published package ships compiled
JavaScript and keeps the `engines` floor of Node.js 22, which CI smoke-tests
against the packed tarball.

Two consequences are enforced rather than documented: `tsconfig.json` sets
`erasableSyntaxOnly`, so TypeScript-only runtime syntax such as parameter
properties will not compile, and relative imports carry a `.ts` extension that
`rewriteRelativeImportExtensions` converts on emit.

`pnpm dev` points `AGENTCHANNELS_HOME` at a gitignored `.dev/` directory. That
also selects a separate operating-system keyring namespace, so development and
tests can never read or delete the operator's real installation secrets.

## Required invariants

- Keep the core `Agent`, `Binding`, `Session`, and `Interaction` model runtime-neutral. Claude-specific types and behavior belong in the runtime adapter.
- Connector credentials and private installation keys belong in the operating-system credential store. Never write them to SQLite or logs.
- Derive the whole installation namespace, including the credential-store service name, from one product home. `--home` must isolate secrets as completely as it isolates SQLite.
- Treat Session execution, channel delivery, and relay transport as independent failure domains. A delivery failure must not turn successful execution into a failed Session.
- Answer a forwarded webhook from local state only. The Relay drops an event whose local answer misses its response budget and never retries, so credential-store reads, provider token refreshes, and worktree creation belong off that path.
- Acknowledge an accepted Session on the channel before creating its worktree. Providers expect a first activity within seconds of the originating event.
- Create Git Session worktrees from the repository's current `HEAD`. Never copy the operator's uncommitted working tree into a Session.
- Delete only worktrees that AgentChannels owns and has verified are clean. Preserve dirty or unowned worktrees.
- New runtime permission decisions are operator-only. Shared users may work in Sessions but may not expand runtime authority.
- Verify Slack and Linear signatures locally from the original raw request body and headers before dispatching work.
- Persist follow-ups that arrive during an active runtime turn and deliver them in order after that turn. Do not steer the active turn implicitly.
- Preserve crash recovery metadata and require an intentional follow-up before resuming interrupted work.
- Keep one canonical Relay HTTP(S) origin per installation. Derive enrollment, webhook, and WebSocket endpoints with URL semantics; never add transient command or environment overrides.
- Enroll a replacement Relay before persisting a cutover, preserve all local state, and require Binding reconfiguration acknowledgment. Never fall back to hosted implicitly or hot-reload a running daemon.
- Keep schema migrations numbered, forward-only, and transactional. Refuse newer schemas and create an operator-only SQLite backup before every persistent migration; rollback restores a backup and never runs a down-migration.
- Suspend foreign-key enforcement while migrating and verify `foreign_key_check` before committing. A migration that rebuilds a table drops the original, and with enforcement on that fires `ON DELETE CASCADE` and silently removes dependent rows.
- Connector and runtime identifiers are opaque. Constrain their shape (`^[a-z][a-z0-9_-]{0,31}$`), never their value, in types, SQLite, and the wire protocol alike. Adding a provider or a runtime must be one new file, not a coordinated release.
- Enrollment authorization is request-only input. Never accept it as a normal argument or persist it in SQLite, the credential store, logs, or output.

## Structure

Three directories are extension points and share one shape: a contract plus one
file per case. `src/connectors` holds channel providers, `src/runtimes` holds
agent runtimes, and `src/service` holds background-service platforms. Adding a
case means adding a file there and nothing else.

`src/model.ts` is the leaf of the dependency graph and imports nothing.
`src/engine` orchestrates Sessions and knows only contracts, never a concrete
provider or runtime. `src/store` owns SQLite, `src/relay` owns remote transport,
`src/cli` owns the terminal, and `src/daemon.ts` is the composition root.

These directions are enforced by `noRestrictedImports` in `biome.json` rather
than by convention, because the one invariant that was documented in prose alone
is the one that had drifted.

`src/index.ts` is the only barrel. Everywhere else, import the module that owns
the symbol so the dependency graph stays legible.

## Compatibility surfaces

Treat these as public compatibility boundaries:

- CLI commands, flags, exit behavior, and `--json` output
- SQLite migrations and persisted status values
- runtime and connector interfaces
- Slack/Linear webhook parsing and delivery payloads
- protocol version and camelCase messages under `src/protocol`
- the connector and runtime identifier shape, which the Relay validates identically

Any protocol change must be coordinated with `agentchannels-relay` and covered in both repositories. Do not make one side accept a wire shape the other side cannot produce or consume.

Release notes must state the component version, supported protocol, schema impact,
and rollback requirements. Publication compatibility uses an exact candidate
Relay digest plus every available exact stable counterpart; never treat a
missing artifact as a passed pairing.

## Testing and completion

Run focused tests first for changed behavior, for example:

```sh
pnpm vitest run test/worktree.test.ts
pnpm vitest run test/product.integration.test.ts
```

Shared temporary homes, Git repositories, and in-memory credential stores live in
`test/helpers/fixtures.ts`. Build new fixtures there rather than in a suite, so
suites cannot drift on whether a repository has a commit or a home is isolated.

Behavior changes should extend the closest focused test. Security, recovery, ordering, worktree, or delivery changes require a regression test at that invariant. Connector and runtime test doubles are appropriate only at external boundaries; use real SQLite and Git where the existing tests do.

Before claiming completion, run the full repository gate:

```sh
pnpm check
```

This runs Biome CI checks, TypeScript type checking, tests, and the production build.
