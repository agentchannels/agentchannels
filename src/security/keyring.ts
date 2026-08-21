import { AsyncEntry } from "@napi-rs/keyring";

/** Secret storage used by connectors without exposing a persistence backend. */
export type CredentialStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
};

/**
 * OS-backed credentials for one AgentChannels installation.
 *
 * The service name is required: it comes from `ProductPaths.keyringService`, so an
 * installation pointed at a different home cannot reach another installation's secrets.
 */
export class KeyringCredentialStore implements CredentialStore {
  private readonly service: string;
  private readonly entryFactory: typeof AsyncEntry;

  constructor(service: string, entryFactory: typeof AsyncEntry = AsyncEntry) {
    this.service = service;
    this.entryFactory = entryFactory;
  }

  async get(key: string): Promise<string | null> {
    const value = await new this.entryFactory(this.service, key).getPassword();
    return value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await new this.entryFactory(this.service, key).setPassword(value);
  }

  async delete(key: string): Promise<void> {
    try {
      await new this.entryFactory(this.service, key).deleteCredential();
    } catch (error) {
      if (
        error instanceof Error &&
        /no.?entry|not found|does not exist/i.test(error.message)
      )
        return;
      throw error;
    }
  }
}
