import { createPublicKey, verify } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialStore } from "../src/security/credentials.js";
import {
  BindingCredentialService,
  InstallationIdentityService,
} from "../src/security/identity.js";

class InMemoryCredentialStore implements CredentialStore {
  private readonly values = new Map<string, string>();
  get(key: string): Promise<string | null> {
    return Promise.resolve(this.values.get(key) ?? null);
  }
  set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
  delete(key: string): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }
}

describe("CredentialStore contract", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("supports explicit test doubles without plaintext persistence", async () => {
    const store = new InMemoryCredentialStore();
    await expect(store.get("slack-token")).resolves.toBeNull();
    await store.set("slack-token", "secret");
    await expect(store.get("slack-token")).resolves.toBe("secret");
    await store.delete("slack-token");
    await expect(store.get("slack-token")).resolves.toBeNull();
  });

  it("refreshes expiring Linear OAuth credentials and persists the rotated token in the keyring boundary", async () => {
    const store = new InMemoryCredentialStore();
    const credentials = new BindingCredentialService(store);
    await credentials.set("bd_linear", {
      oauthProvider: "linear",
      apiToken: "expired",
      refreshToken: "refresh-old",
      clientId: "client",
      clientSecret: "secret",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: "access-new",
              refresh_token: "refresh-new",
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        ),
      ),
    );

    await expect(credentials.require("bd_linear")).resolves.toMatchObject({
      apiToken: "access-new",
      refreshToken: "refresh-new",
    });
    await expect(store.get("binding:bd_linear")).resolves.toContain(
      "access-new",
    );
  });

  it("creates a persistent raw Ed25519 public key and signs relay challenges", async () => {
    const store = new InMemoryCredentialStore();
    const identities = new InstallationIdentityService(store);
    const identity = await identities.getOrCreate();
    const rawPublicKey = Buffer.from(identity.publicKeyBase64, "base64");
    expect(rawPublicKey).toHaveLength(32);
    const signature = Buffer.from(
      await identities.signChallenge("relay-nonce"),
      "base64",
    );
    const publicKey = createPublicKey({
      key: {
        kty: "OKP",
        crv: "Ed25519",
        x: rawPublicKey.toString("base64url"),
      },
      format: "jwk",
    });
    expect(verify(null, Buffer.from("relay-nonce"), publicKey, signature)).toBe(
      true,
    );
    await expect(identities.getOrCreate()).resolves.toEqual(identity);
  });

  it("renews Linear client-credentials app tokens without user intervention", async () => {
    const store = new InMemoryCredentialStore();
    const credentials = new BindingCredentialService(store);
    await credentials.set("bd_linear_client", {
      oauthProvider: "linear-client-credentials",
      clientId: "client",
      clientSecret: "secret",
      apiToken: "expired",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: "client-access-new",
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        ),
      ),
    );

    await expect(
      credentials.require("bd_linear_client"),
    ).resolves.toMatchObject({
      apiToken: "client-access-new",
      accessToken: "client-access-new",
    });
  });
});
