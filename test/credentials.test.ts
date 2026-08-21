import { createPublicKey, verify } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveProductPaths } from "../src/paths.ts";
import {
  KeyringCredentialStore,
  type CredentialStore,
} from "../src/security/keyring.ts";
import {
  BindingCredentialService,
  InstallationIdentityService,
} from "../src/security/identity.ts";

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

describe("keyring namespace isolation", () => {
  it("keeps the stable service name for the default installation home", () => {
    const paths = resolveProductPaths({ HOME: homedir() });
    expect(paths.root).toBe(join(homedir(), ".agentchannels"));
    expect(paths.keyringService).toBe("agentchannels");
  });

  it("gives any overridden home its own keyring namespace", () => {
    const base = { HOME: homedir() };
    const scoped = resolveProductPaths({
      ...base,
      AGENTCHANNELS_HOME: "/tmp/agentchannels-a",
    });
    const other = resolveProductPaths({
      ...base,
      AGENTCHANNELS_HOME: "/tmp/agentchannels-b",
    });
    const stable = resolveProductPaths(base).keyringService;
    expect(scoped.keyringService).not.toBe(stable);
    expect(other.keyringService).not.toBe(stable);
    expect(scoped.keyringService).not.toBe(other.keyringService);
    // Stable across runs so a sandboxed home keeps reaching its own secrets.
    expect(
      resolveProductPaths({
        ...base,
        AGENTCHANNELS_HOME: "/tmp/agentchannels-a",
      }).keyringService,
    ).toBe(scoped.keyringService);
  });

  it("reads and writes only within its own service namespace", async () => {
    const entries = new Map<string, string>();
    // Must be constructible: KeyringCredentialStore calls `new` on this.
    class FakeEntry {
      private readonly id: string;
      constructor(service: string, key: string) {
        this.id = `${service} ${key}`;
      }
      getPassword() {
        return Promise.resolve(entries.get(this.id) ?? null);
      }
      setPassword(value: string) {
        entries.set(this.id, value);
        return Promise.resolve();
      }
      deleteCredential() {
        return Promise.resolve(entries.delete(this.id));
      }
    }
    const entryFactory = FakeEntry as unknown as ConstructorParameters<
      typeof KeyringCredentialStore
    >[1];

    const real = new KeyringCredentialStore("agentchannels", entryFactory);
    const sandbox = new KeyringCredentialStore(
      "agentchannels:dead",
      entryFactory,
    );
    await real.set("installation:private-key", "real-key");
    await sandbox.set("installation:private-key", "sandbox-key");

    await expect(real.get("installation:private-key")).resolves.toBe(
      "real-key",
    );
    await sandbox.delete("installation:private-key");
    await expect(sandbox.get("installation:private-key")).resolves.toBeNull();
    await expect(real.get("installation:private-key")).resolves.toBe(
      "real-key",
    );
  });
});

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
    });
    await expect(
      credentials.require("bd_linear_client"),
    ).resolves.not.toHaveProperty("accessToken");
  });
});
