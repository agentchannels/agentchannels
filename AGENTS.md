# AgentChannels contributor instructions

## Purpose and boundary

This repository is the user-installed AgentChannels product: its CLI, local daemon, SQLite state, Git worktrees, Claude runtime adapter, and Slack/Linear connector semantics. The separate `agentchannels-relay` repository is transport only.

Use the existing TypeScript, Node.js 22+, and pnpm toolchain.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm check
```

## Required invariants

- Keep the core `Agent`, `Binding`, `Session`, and `Interaction` model runtime-neutral. Claude-specific types and behavior belong in the runtime adapter.
- Connector credentials and private installation keys belong in the operating-system credential store. Never write them to SQLite or logs.
- Treat Session execution, channel delivery, and relay transport as independent failure domains. A delivery failure must not turn successful execution into a failed Session.
- Create Git Session worktrees from the repository's current `HEAD`. Never copy the operator's uncommitted working tree into a Session.
- Delete only worktrees that AgentChannels owns and has verified are clean. Preserve dirty or unowned worktrees.
- New runtime permission decisions are operator-only. Shared users may work in Sessions but may not expand runtime authority.
- Verify Slack and Linear signatures locally from the original raw request body and headers before dispatching work.
- Persist follow-ups that arrive during an active runtime turn and deliver them in order after that turn. Do not steer the active turn implicitly.
- Preserve crash recovery metadata and require an intentional follow-up before resuming interrupted work.
- Keep one canonical Relay HTTP(S) origin per installation. Derive enrollment, webhook, and WebSocket endpoints with URL semantics; never add transient command or environment overrides.
- Enroll a replacement Relay before persisting a cutover, preserve all local state, and require Binding reconfiguration acknowledgment. Never fall back to hosted implicitly or hot-reload a running daemon.
- Keep schema migrations numbered, forward-only, and transactional. Refuse newer schemas and create an operator-only SQLite backup before every persistent migration; rollback restores a backup and never runs a down-migration.
- Enrollment authorization is request-only input. Never accept it as a normal argument or persist it in SQLite, the credential store, logs, or output.

## Compatibility surfaces

Treat these as public compatibility boundaries:

- CLI commands, flags, exit behavior, and `--json` output
- SQLite migrations and persisted status values
- runtime and connector interfaces
- Slack/Linear webhook parsing and delivery payloads
- protocol version and camelCase messages under `src/protocol`

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

Behavior changes should extend the closest focused test. Security, recovery, ordering, worktree, or delivery changes require a regression test at that invariant. Connector and runtime test doubles are appropriate only at external boundaries; use real SQLite and Git where the existing tests do.

Before claiming completion, run the full repository gate:

```sh
pnpm check
```

This runs Biome CI checks, TypeScript type checking, tests, and the production build.
