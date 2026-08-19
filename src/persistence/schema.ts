import type Database from "better-sqlite3";

/** The schema version is kept in SQLite so an existing local installation can be upgraded safely. */
export const CURRENT_SCHEMA_VERSION = 1;

export function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const version = db
    .prepare(
      "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
    )
    .get() as { version: number };
  if (version.version >= CURRENT_SCHEMA_VERSION) return;
  if (version.version !== 0)
    throw new Error(
      `Unsupported persistence schema version ${String(version.version)}`,
    );

  const applyV1 = db.transaction(() => {
    db.exec(`
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK (length(name) > 0),
        cwd TEXT NOT NULL,
        additional_directories_json TEXT NOT NULL DEFAULT '[]',
        runtime TEXT NOT NULL CHECK (runtime = 'claude-code'),
        created_at TEXT NOT NULL
      );
      CREATE INDEX agents_cwd_idx ON agents(cwd);

      CREATE TABLE installations (
        id TEXT PRIMARY KEY,
        public_key TEXT NOT NULL UNIQUE,
        relay_url TEXT,
        created_at TEXT NOT NULL,
        last_seen_at TEXT
      );

      CREATE TABLE bindings (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        connector TEXT NOT NULL CHECK (connector IN ('linear', 'slack')),
        operator_user_id TEXT NOT NULL CHECK (length(operator_user_id) > 0),
        external_installation_id TEXT NOT NULL CHECK (length(external_installation_id) > 0),
        created_at TEXT NOT NULL,
        UNIQUE (agent_id, connector, external_installation_id)
      );
      CREATE INDEX bindings_agent_id_idx ON bindings(agent_id);

      CREATE TABLE binding_setups (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        connector TEXT NOT NULL CHECK (connector IN ('linear', 'slack')),
        created_at TEXT NOT NULL,
        UNIQUE (agent_id, connector)
      );

      CREATE TABLE access_grants (
        binding_id TEXT NOT NULL REFERENCES bindings(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL CHECK (length(user_id) > 0),
        granted_at TEXT NOT NULL,
        PRIMARY KEY (binding_id, user_id)
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        binding_id TEXT NOT NULL REFERENCES bindings(id) ON DELETE CASCADE,
        remote_conversation_id TEXT NOT NULL CHECK (length(remote_conversation_id) > 0),
        runtime_session_id TEXT,
        cwd TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting', 'completed', 'interrupted', 'failed', 'stopped')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        retention_expires_at TEXT,
        UNIQUE (binding_id, remote_conversation_id)
      );
      CREATE INDEX sessions_status_idx ON sessions(status);
      CREATE INDEX sessions_retention_idx ON sessions(retention_expires_at);

      CREATE TABLE interactions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('question', 'permission', 'plan')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'answered', 'denied', 'cancelled')),
        request_json TEXT NOT NULL,
        response_json TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX interactions_session_idx ON interactions(session_id);

      CREATE TABLE followups (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        remote_user_id TEXT NOT NULL CHECK (length(remote_user_id) > 0),
        text TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'delivered')),
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        UNIQUE (session_id, sequence)
      );
      CREATE INDEX followups_queue_idx ON followups(session_id, status, sequence);

      CREATE TABLE deliveries (
        id TEXT PRIMARY KEY,
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        connector TEXT NOT NULL CHECK (connector IN ('linear', 'slack')),
        remote_conversation_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('progress', 'final', 'question', 'permission', 'plan', 'stopped', 'error')),
        body TEXT NOT NULL,
        metadata_json TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'retrying', 'delivered', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX deliveries_due_idx ON deliveries(status, next_attempt_at);
      CREATE INDEX deliveries_session_idx ON deliveries(session_id);

      CREATE TABLE ingress_events (
        binding_id TEXT NOT NULL REFERENCES bindings(id) ON DELETE CASCADE,
        event_id TEXT NOT NULL CHECK (length(event_id) > 0),
        received_at TEXT NOT NULL,
        PRIMARY KEY (binding_id, event_id)
      );
    `);
    db.prepare(
      "INSERT INTO schema_migrations(version, applied_at) VALUES (1, ?)",
    ).run(new Date().toISOString());
  });
  applyV1();
}
