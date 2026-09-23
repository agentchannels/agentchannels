FROM oven/bun:1.4.0 AS builder

WORKDIR /build
COPY package.json bun.lock bunfig.toml ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/cli/package.json apps/cli/
COPY apps/relay/package.json apps/relay/
RUN bun install --frozen-lockfile --filter agentchannels-relay
COPY packages/protocol packages/protocol
COPY apps/relay apps/relay
RUN bun build apps/relay/src/main.ts --compile --minify \
      --outfile /build/agentchannels-relay

FROM debian:bookworm-slim AS runtime

RUN groupadd --gid 10001 agentchannels-relay \
    && useradd --uid 10001 --gid 10001 --no-create-home \
      --home-dir /var/lib/agentchannels-relay --shell /usr/sbin/nologin \
      agentchannels-relay \
    && mkdir -p -m 0700 /var/lib/agentchannels-relay/backups \
    && chown -R 10001:10001 /var/lib/agentchannels-relay

COPY --from=builder --chown=10001:10001 \
  /build/agentchannels-relay \
  /usr/local/bin/agentchannels-relay

ENV AGENTCHANNELS_RELAY_BIND=0.0.0.0:8787 \
    AGENTCHANNELS_RELAY_DATABASE=/var/lib/agentchannels-relay/agentchannels-relay.db

WORKDIR /var/lib/agentchannels-relay
USER 10001:10001
EXPOSE 8787

ENTRYPOINT ["/usr/local/bin/agentchannels-relay"]
