import type { BindingCredentialService } from "./identity.ts";

export type CachedCredentials = Readonly<Record<string, string>>;

export type BindingCredentialCacheOptions = {
  service: BindingCredentialService;
  /** How long a cached entry is served before the keeper refreshes it. */
  refreshIntervalMs?: number;
  now?: () => number;
};

type Entry = {
  credentials: CachedCredentials;
  loadedAtMs: number;
};

const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60_000;

/**
 * Keeps Binding credentials in memory so webhook handling never performs I/O.
 *
 * The Relay gives the local installation a fixed budget to answer a forwarded
 * webhook and drops the event when that budget is missed, with no retry. Reading
 * the operating-system keyring is an IPC round trip and refreshing a provider
 * token is an HTTP round trip, so neither may sit on that path: they run here,
 * ahead of time, and the ingress path performs a synchronous map lookup.
 */
export class BindingCredentialCache {
  private readonly service: BindingCredentialService;
  private readonly refreshIntervalMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();
  /** One load per Binding at a time; concurrent callers await the same promise. */
  private readonly inFlight = new Map<string, Promise<CachedCredentials>>();

  public constructor(options: BindingCredentialCacheOptions) {
    this.service = options.service;
    this.refreshIntervalMs =
      options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** Synchronous read for latency-bound paths. Undefined means "not primed yet". */
  public cached(bindingId: string): CachedCredentials | undefined {
    return this.entries.get(bindingId)?.credentials;
  }

  public invalidate(bindingId: string): void {
    this.entries.delete(bindingId);
  }

  /** Load any Binding that is not cached yet. Safe to call repeatedly. */
  public async prime(bindingIds: Iterable<string>): Promise<void> {
    const missing = [...bindingIds].filter(
      (bindingId) => !this.entries.has(bindingId),
    );
    await Promise.allSettled(
      missing.map((bindingId) => this.load(bindingId, false)),
    );
  }

  /**
   * Refresh entries older than the refresh interval and drop Bindings that no
   * longer exist. Returns the number of entries refreshed.
   */
  public async keepFresh(bindingIds: Iterable<string>): Promise<number> {
    const live = new Set(bindingIds);
    for (const bindingId of [...this.entries.keys()])
      if (!live.has(bindingId)) this.entries.delete(bindingId);

    const cutoff = this.now() - this.refreshIntervalMs;
    const due = [...live].filter((bindingId) => {
      const entry = this.entries.get(bindingId);
      return entry === undefined || entry.loadedAtMs <= cutoff;
    });
    const results = await Promise.allSettled(
      due.map((bindingId) => this.load(bindingId, true)),
    );
    return results.filter((result) => result.status === "fulfilled").length;
  }

  private load(bindingId: string, force: boolean): Promise<CachedCredentials> {
    const existing = this.inFlight.get(bindingId);
    if (existing !== undefined) return existing;
    const pending = (async () => {
      // require() also renews a provider token that is at or near expiry, which
      // is exactly the HTTP call that must not happen while a webhook waits.
      const credentials = await this.service.require(bindingId);
      if (force || !this.entries.has(bindingId))
        this.entries.set(bindingId, {
          credentials,
          loadedAtMs: this.now(),
        });
      return credentials;
    })().finally(() => {
      this.inFlight.delete(bindingId);
    });
    this.inFlight.set(bindingId, pending);
    return pending;
  }
}
