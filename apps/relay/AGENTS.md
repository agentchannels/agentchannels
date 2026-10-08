# AgentChannels Relay

The relay is transport only. It authenticates local installations, stores
Binding routing metadata, and forwards webhook requests over WebSocket. It does
not execute agents, interpret Slack or Linear events, make access decisions, or
verify provider signatures. That ignorance is a product promise: operators trust
a hosted relay because it cannot read or keep what passes through it.

## Invariants

- Webhook headers and bodies exist only in request and connection memory. Never
  persist or log webhook content.
- SQLite stores installation Ed25519 public keys, Binding routing metadata, and
  timestamps only.
- A connector is an opaque routing key. Validate its shape through
  `@agentchannels/protocol`, never its value. Adding a provider must not require a
  relay release.
- Malformed connectors and unknown Bindings return 404. A known Binding with no
  live connection, or one that misses the response budget, returns 200 and drops
  the event. It never becomes delayed work.
- Closing a connection settles every pending delivery at once. JavaScript has no
  drop semantics, so an unsettled promise would hold a webhook for the full
  budget.
- A connection's outbox is bounded. A peer that stops reading makes deliveries
  fail within their budget rather than buffering without limit.
- One installation has one live connection. A reconnect closes the socket it
  replaces.
- Authentication signs `authenticationPayload` from `@agentchannels/protocol`:
  the relay origin, the installation, and the nonce. A signature made for one
  relay is useless at another, so a relay an operator once tried cannot replay
  that installation's identity elsewhere.
- Enrollment tokens are compared in constant time over fixed-width digests, and
  every unauthorized enrollment gets an identical response.
- Migrations are numbered, forward-only, and transactional. A database at an
  older schema is backed up before migrating; a newer schema is refused without
  being touched.
- The listener has no TLS. Public deployment needs an edge TLS and rate-limit
  boundary and exactly one enrollment policy.

The relay must not import the CLI. `biome.json` enforces this.

## Commands

```sh
bun run --filter agentchannels-relay test
bun apps/relay/src/main.ts
docker build -f apps/relay/Dockerfile -t agentchannels-relay:local .
docker compose -f apps/relay/compose.yml -f apps/relay/compose.build.yml up -d
```

`test/behavior.test.ts` drives the relay only through HTTP and WebSocket, so it
can run against any implementation:

```sh
AGENTCHANNELS_RELAY_COMMAND=/path/to/relay bun test test/behavior.test.ts
```

## Configuration

- `AGENTCHANNELS_RELAY_ORIGIN`: the public origin installations dial, such as
  `https://relay.example.com`. It defaults to `http://` plus the bind address,
  which is only right without a proxy. Compose requires it.
- `AGENTCHANNELS_RELAY_BIND`: listen address, default `127.0.0.1:8787`.
- `AGENTCHANNELS_RELAY_DATABASE`: SQLite path, default `agentchannels-relay.db`.
- Exactly one of `AGENTCHANNELS_RELAY_ENROLLMENT_TOKEN`,
  `AGENTCHANNELS_RELAY_ENROLLMENT_TOKEN_FILE`, or
  `AGENTCHANNELS_RELAY_ALLOW_OPEN_ENROLLMENT=true`. A token file loses trailing
  ASCII whitespace only.
