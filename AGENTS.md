# AgentChannels contributor instructions

AgentChannels lets people use an existing local Claude Code environment from
Slack and Linear. This repository holds every part of it:

| Path | What it is | Ships as |
|---|---|---|
| `apps/cli` | The CLI, daemon, connectors, and runtime adapter | A compiled binary per platform |
| `apps/relay` | The transport-only webhook relay | A container image |
| `packages/protocol` | The wire protocol both apps speak | Source, imported by both |

Read the `AGENTS.md` inside an app before changing it.

## Toolchain

Bun runs, tests, and compiles everything. There is no build step in the
edit-run loop; `bun` executes TypeScript directly.

```sh
bun install --frozen-lockfile
bun run check
bun run format
```

`bun run check` runs Biome, type checking, every workspace's tests, and both
compiled builds. Run it before claiming completion.

Code carries no comments. Names and structure carry meaning; invariants live in
`AGENTS.md` files and test names. TypeScript is strict, `any` is not used, and
external input is parsed through a schema before it is trusted.

## Boundaries

The relay's ignorance is a product promise: it cannot read, keep, or act on what
passes through it. Separate repositories used to guarantee that. Now
`noRestrictedImports` in `biome.json` does:

- `apps/relay` must not import `apps/cli`.
- `apps/cli` must not import `apps/relay`.
- `packages/protocol` must not import either app.

The apps meet only at `packages/protocol`.

## Changing the protocol

A protocol change is one pull request that edits `packages/protocol`, both apps,
and the conformance fixture in `packages/protocol/test`. It is covered by the
fixture, by the relay's black-box suite in `apps/relay/test/behavior.test.ts`,
and by the CLI's end-to-end test against a real relay process in
`apps/cli/test/relay-roundtrip.integration.test.ts`.

The two apps release on separate tracks, so versions are always skewed: a CLI
installed last month talks to today's relay. The protocol version is what binds
them. The relay reports the versions it supports in `unsupported_protocol`, and
`deploy-relay` refuses to deploy a relay that no longer speaks the last released
CLI's protocol.

## Releases

- CLI: push a `cli-vX.Y.Z` tag matching `apps/cli/package.json`.
  `release-cli.yml` compiles the binary natively on each platform and publishes a
  GitHub release with checksums.
- Relay: every merge to `main` that touches the relay or the protocol runs
  `deploy-relay.yml`, which verifies the hardened container and pushes the image.
  The version tag is pushed once and never overwritten; `apps/relay/compose.yml`
  pins it.
