const DOMAIN = "agentchannels-relay-auth:v2";

export function authenticationPayload(input: {
  origin: string;
  installationId: string;
  nonce: string;
}): string {
  return [
    DOMAIN,
    new URL(input.origin).origin,
    input.installationId,
    input.nonce,
  ].join("\n");
}
