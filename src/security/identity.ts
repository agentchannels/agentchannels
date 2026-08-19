import {
  createPrivateKey,
  generateKeyPairSync,
  randomUUID,
  sign,
} from "node:crypto";

import type { CredentialStore } from "./credentials.js";

const installationMetadataKey = "installation:metadata";
const installationPrivateKey = "installation:private-key";

export type InstallationIdentity = {
  installationId: string;
  publicKeyBase64: string;
};

export async function issueLinearClientCredentials(
  clientId: string,
  clientSecret: string,
): Promise<{ apiToken: string; expiresAt: string }> {
  const response = await fetch("https://api.linear.app/oauth/token", {
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
    throw new Error(
      `Linear client-credentials authorization failed: ${token.error_description ?? `HTTP ${String(response.status)}`}`,
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
  public constructor(private readonly credentials: CredentialStore) {}

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
        throw new Error(
          "Installation identity metadata in the OS credential store is invalid",
        );
      }
      return {
        installationId: parsed.installationId,
        publicKeyBase64: parsed.publicKeyBase64,
      };
    }
    if (existing !== null || privateKey !== null) {
      throw new Error(
        "Installation identity is incomplete; remove both keyring entries before retrying",
      );
    }

    const pair = generateKeyPairSync("ed25519");
    const publicJwk = pair.publicKey.export({ format: "jwk" });
    if (typeof publicJwk.x !== "string")
      throw new Error("Generated Ed25519 key is missing its public component");
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
      throw new Error(
        "Installation private key is missing from the OS credential store",
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
  public constructor(private readonly credentials: CredentialStore) {}

  public get(bindingId: string): Promise<string | null> {
    return this.credentials.get(`binding:${bindingId}`);
  }

  public set(
    bindingId: string,
    values: Readonly<Record<string, string>>,
  ): Promise<void> {
    return this.credentials.set(`binding:${bindingId}`, JSON.stringify(values));
  }

  public async require(
    bindingId: string,
  ): Promise<Readonly<Record<string, string>>> {
    const value = await this.get(bindingId);
    if (value === null)
      throw new Error(`Credentials for binding ${bindingId} are missing`);
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
        ),
      );
      credentials.accessToken = credentials.apiToken ?? "";
      await this.set(bindingId, credentials);
    }
    if (
      credentials.oauthProvider === "linear" &&
      credentials.refreshToken !== undefined &&
      credentials.clientId !== undefined &&
      credentials.clientSecret !== undefined &&
      (credentials.expiresAt === undefined ||
        Date.parse(credentials.expiresAt) <= Date.now() + 60_000)
    ) {
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credentials.refreshToken,
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
      });
      const response = await fetch("https://api.linear.app/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      const refreshed = (await response.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        error_description?: string;
      };
      if (!response.ok || refreshed.access_token === undefined) {
        throw new Error(
          `Linear OAuth refresh failed: ${refreshed.error_description ?? `HTTP ${String(response.status)}`}`,
        );
      }
      credentials.apiToken = refreshed.access_token;
      credentials.accessToken = refreshed.access_token;
      if (refreshed.refresh_token !== undefined)
        credentials.refreshToken = refreshed.refresh_token;
      credentials.expiresAt = new Date(
        Date.now() + (refreshed.expires_in ?? 86_400) * 1000,
      ).toISOString();
      await this.set(bindingId, credentials);
    }
    return credentials;
  }
}
