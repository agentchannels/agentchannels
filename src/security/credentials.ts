import { AsyncEntry } from "@napi-rs/keyring";

/** Secret storage used by connectors without exposing a persistence backend. */
export type CredentialStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
};

/** OS-backed credentials for the AgentChannels installation. */
export class KeyringCredentialStore implements CredentialStore {
  static readonly service = "agentchannels";

  constructor(
    private readonly service = KeyringCredentialStore.service,
    private readonly entryFactory: typeof AsyncEntry = AsyncEntry,
  ) {}

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
