import { AgentChannelsError, internalError, invalidState } from "../errors.ts";
import {
  createPrivateKey,
  generateKeyPairSync,
  randomUUID,
  sign,
} from "node:crypto";

import type { CredentialStore } from "./keyring.ts";

export type IdentityFetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const installationMetadataKey = "installation:metadata";
const installationPrivateKey = "installation:private-key";

export type InstallationIdentity = {
  installationId: string;
  publicKeyBase64: string;
};

export async function issueLinearClientCredentials(
  clientId: string,
  clientSecret: string,
  fetcher: IdentityFetchLike = fetch,
): Promise<{ apiToken: string; expiresAt: string }> {
  const response = await fetcher("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "read,write,app:mentionable,app:assignable",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const token = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!response.ok || token.access_token === undefined) {
    throw new AgentChannelsError(
      "PROVIDER_REJECTED",
      `Linear client-credentials authorization failed: ${token.error_description ?? `HTTP ${String(response.status)}`}`,
      ["Rerun agentchannels init and re-enter the Linear application secrets."],
    );
  }
  return {
    apiToken: token.access_token,
    expiresAt: new Date(
      Date.now() + (token.expires_in ?? 30 * 24 * 60 * 60) * 1000,
    ).toISOString(),
  };
}

export class InstallationIdentityService {
  private readonly credentials: CredentialStore;

  public constructor(credentials: CredentialStore) {
    this.credentials = credentials;
  }

  public async getOrCreate(): Promise<InstallationIdentity> {
    const existing = await this.credentials.get(installationMetadataKey);
    const privateKey = await this.credentials.get(installationPrivateKey);
    if (existing !== null && privateKey !== null) {
      const parsed = JSON.parse(existing) as Partial<InstallationIdentity>;
      if (
        typeof parsed.installationId !== "string" ||
        typeof parsed.publicKeyBase64 !== "string" ||
        Buffer.from(parsed.publicKeyBase64, "base64").length !== 32
      ) {
        throw invalidState(
          "Installation identity metadata in the OS credential store is invalid.",
          ["Remove both agentchannels keyring entries, then rerun init."],
        );
      }
      return {
        installationId: parsed.installationId,
        publicKeyBase64: parsed.publicKeyBase64,
      };
    }
    if (existing !== null || privateKey !== null) {
      throw invalidState("Installation identity is incomplete.", [
        "Remove both agentchannels keyring entries, then rerun init.",
      ]);
    }

    const pair = generateKeyPairSync("ed25519");
    const publicJwk = pair.publicKey.export({ format: "jwk" });
    if (typeof publicJwk.x !== "string")
      throw internalError(
        "Generated Ed25519 key is missing its public component.",
      );
    const identity: InstallationIdentity = {
      installationId: `in_${randomUUID()}`,
      publicKeyBase64: Buffer.from(publicJwk.x, "base64url").toString("base64"),
    };
    try {
      await this.credentials.set(
        installationPrivateKey,
        pair.privateKey
          .export({ format: "der", type: "pkcs8" })
          .toString("base64"),
      );
      await this.credentials.set(
        installationMetadataKey,
        JSON.stringify(identity),
      );
    } catch (error) {
      await Promise.allSettled([
        this.credentials.delete(installationPrivateKey),
        this.credentials.delete(installationMetadataKey),
      ]);
      throw error;
    }
    return identity;
  }

  public async signChallenge(nonce: string): Promise<string> {
    const encoded = await this.credentials.get(installationPrivateKey);
    if (encoded === null)
      throw invalidState(
        "Installation private key is missing from the OS credential store.",
        ["Rerun agentchannels init to re-enroll this installation."],
      );
    const key = createPrivateKey({
      key: Buffer.from(encoded, "base64"),
      format: "der",
      type: "pkcs8",
    });
    return sign(null, Buffer.from(nonce, "utf8"), key).toString("base64");
  }
}

export class BindingCredentialService {
  private readonly fetcher: IdentityFetchLike | undefined;

  private readonly credentials: CredentialStore;

  public constructor(
    credentials: CredentialStore,
    options: Readonly<{ fetch?: IdentityFetchLike }> = {},
  ) {
    this.credentials = credentials;
    this.fetcher = options.fetch;
  }

  public get(bindingId: string): Promise<string | null> {
    return this.credentials.get(`binding:${bindingId}`);
  }

  public set(
    bindingId: string,
    values: Readonly<Record<string, string>>,
  ): Promise<void> {
    return this.credentials.set(`binding:${bindingId}`, JSON.stringify(values));
  }

  public delete(bindingId: string): Promise<void> {
    return this.credentials.delete(`binding:${bindingId}`);
  }

  public async require(
    bindingId: string,
  ): Promise<Readonly<Record<string, string>>> {
    const value = await this.get(bindingId);
    if (value === null)
      throw invalidState(`Credentials for Binding ${bindingId} are missing.`, [
        "Rerun agentchannels init to re-enter provider credentials.",
      ]);
    const credentials = JSON.parse(value) as Record<string, string>;
    if (
      credentials.oauthProvider === "linear-client-credentials" &&
      credentials.clientId !== undefined &&
      credentials.clientSecret !== undefined &&
      (credentials.expiresAt === undefined ||
        Date.parse(credentials.expiresAt) <= Date.now() + 60_000)
    ) {
      Object.assign(
        credentials,
        await issueLinearClientCredentials(
          credentials.clientId,
          credentials.clientSecret,
          this.fetcher ?? fetch,
        ),
      );
      await this.set(bindingId, credentials);
    }
    return credentials;
  }
}
