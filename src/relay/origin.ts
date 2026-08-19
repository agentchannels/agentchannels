import type { ConnectorType } from "../core/types.js";

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
    throw new Error("Relay origin must be an absolute HTTP or HTTPS URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Relay origin must use HTTP or HTTPS");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("Relay origin must not contain embedded credentials");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error("Relay origin must not contain a query or fragment");
  }
  if (url.pathname !== "/") {
    throw new Error("Relay origin must not contain a path");
  }
  if (url.protocol === "http:" && !isLoopback(url.hostname)) {
    throw new Error("Non-loopback Relay origins must use HTTPS");
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
