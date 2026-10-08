import { AgentChannelsError } from "../errors.ts";
import type { ConnectorType } from "../model.ts";

export const HOSTED_RELAY_ORIGIN = "https://relay.agentchannels.io";

export type RelayEndpoints = {
  origin: string;
  installationUrl: URL;
  websocketUrl: URL;
  webhookUrl(connector: ConnectorType, bindingId: string): URL;
};

function isLoopback(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normalized);
  if (match === null) return false;
  const octets = match.slice(1).map(Number);
  return (
    octets.every((octet) => octet >= 0 && octet <= 255) && octets[0] === 127
  );
}

export function parseRelayOrigin(value: string): RelayEndpoints {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AgentChannelsError(
      "USAGE_ERROR",
      "Relay origin must be an absolute HTTP or HTTPS URL.",
      [
        "Pass --url with a bare HTTPS origin such as https://relay.example.com.",
      ],
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AgentChannelsError(
      "USAGE_ERROR",
      "Relay origin must use HTTP or HTTPS.",
      [
        "Pass --url with a bare HTTPS origin such as https://relay.example.com.",
      ],
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new AgentChannelsError(
      "USAGE_ERROR",
      "Relay origin must not contain embedded credentials.",
      [
        "Pass --url with a bare HTTPS origin such as https://relay.example.com.",
      ],
    );
  }
  if (url.search !== "" || url.hash !== "") {
    throw new AgentChannelsError(
      "USAGE_ERROR",
      "Relay origin must not contain a query or fragment.",
      [
        "Pass --url with a bare HTTPS origin such as https://relay.example.com.",
      ],
    );
  }
  if (url.pathname !== "/") {
    throw new AgentChannelsError(
      "USAGE_ERROR",
      "Relay origin must not contain a path.",
      [
        "Pass --url with a bare HTTPS origin such as https://relay.example.com.",
      ],
    );
  }
  if (url.protocol === "http:" && !isLoopback(url.hostname)) {
    throw new AgentChannelsError(
      "USAGE_ERROR",
      "Non-loopback Relay origins must use HTTPS.",
      [
        "Pass --url with a bare HTTPS origin such as https://relay.example.com.",
      ],
    );
  }
  const origin = url.origin;
  const installationUrl = new URL("/v1/installations", origin);
  const websocketUrl = new URL("/v1/connect", origin);
  websocketUrl.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return {
    origin,
    installationUrl,
    websocketUrl,
    webhookUrl(connector, bindingId) {
      return new URL(
        `/v1/webhooks/${encodeURIComponent(connector)}/${encodeURIComponent(bindingId)}`,
        origin,
      );
    },
  };
}
