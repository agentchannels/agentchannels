import type { Database } from "bun:sqlite";

export type Registration = "registered" | "conflict" | "capacity";

export type RouteBinding = Readonly<{ bindingId: string; connector: string }>;

const OPEN_ENROLLMENT_CAPACITY = 10_000;
const INACTIVE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

export class RelayStore {
  private readonly db: Database;
  private readonly now: () => Date;

  constructor(db: Database, now: () => Date = () => new Date()) {
    this.db = db;
    this.now = now;
  }

  register(
    installationId: string,
    publicKey: Uint8Array,
    options: { open: boolean },
  ): Registration {
    const existing = this.publicKey(installationId);
    if (existing !== null)
      return Buffer.from(existing).equals(publicKey)
        ? "registered"
        : "conflict";
    if (options.open) {
      this.pruneInactive();
      if (this.count() >= OPEN_ENROLLMENT_CAPACITY) return "capacity";
    }
    this.db
      .query(
        "INSERT INTO installations (installation_id, public_key, created_at) VALUES (?, ?, ?)",
      )
      .run(installationId, publicKey, this.timestamp());
    return "registered";
  }

  publicKey(installationId: string): Uint8Array | null {
    return (
      this.db
        .query<{ public_key: Uint8Array }, [string]>(
          "SELECT public_key FROM installations WHERE installation_id = ?",
        )
        .get(installationId)?.public_key ?? null
    );
  }

  touch(installationId: string): void {
    this.db
      .query(
        "UPDATE installations SET last_connected_at = ? WHERE installation_id = ?",
      )
      .run(this.timestamp(), installationId);
  }

  replaceBindings(
    installationId: string,
    bindings: readonly RouteBinding[],
  ): boolean {
    const replace = this.db.transaction(() => {
      this.db
        .query("DELETE FROM bindings WHERE installation_id = ?")
        .run(installationId);
      const insert = this.db.query(
        "INSERT INTO bindings (binding_id, connector, installation_id, updated_at) VALUES (?, ?, ?, ?)",
      );
      for (const binding of bindings)
        insert.run(
          binding.bindingId,
          binding.connector,
          installationId,
          this.timestamp(),
        );
    });
    try {
      replace();
      return true;
    } catch {
      return false;
    }
  }

  owner(bindingId: string, connector: string): string | null {
    return (
      this.db
        .query<{ installation_id: string }, [string, string]>(
          "SELECT installation_id FROM bindings WHERE binding_id = ? AND connector = ?",
        )
        .get(bindingId, connector)?.installation_id ?? null
    );
  }

  private count(): number {
    return (
      this.db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM installations",
        )
        .get()?.count ?? 0
    );
  }

  private pruneInactive(): void {
    const cutoff = new Date(this.now().getTime() - INACTIVE_AFTER_MS);
    this.db
      .query(
        "DELETE FROM installations WHERE COALESCE(last_connected_at, created_at) < ?",
      )
      .run(cutoff.toISOString());
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}
