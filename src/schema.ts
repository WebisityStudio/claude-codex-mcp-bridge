import type { DatabaseSync } from "node:sqlite";

/**
 * Current schema version, stored in SQLite's `PRAGMA user_version`.
 *
 * Every migration is additive: new tables, new nullable columns or columns
 * with defaults. Older bridge processes that are still running against the
 * same database must keep working after a newer process migrates it.
 */
export const SCHEMA_VERSION = 2;

function columns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function addColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  if (!columns(db, table).has(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

const MIGRATIONS: Array<(db: DatabaseSync) => void> = [
  // v1: the 0.3.0 baseline. Idempotent so unversioned 0.3.0 databases adopt it.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        body TEXT NOT NULL,
        thread_id TEXT,
        idempotency_key TEXT,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_idempotency
        ON messages (from_agent, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_messages_to ON messages (to_agent);
      CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (thread_id);

      CREATE TABLE IF NOT EXISTS acknowledgements (
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        agent TEXT NOT NULL,
        acked_at TEXT NOT NULL,
        PRIMARY KEY (message_id, agent)
      );

      CREATE TABLE IF NOT EXISTS agents (
        name TEXT PRIMARY KEY,
        capabilities TEXT NOT NULL,
        registered_at TEXT NOT NULL,
        last_seen TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS orchestration_runs (
        id TEXT PRIMARY KEY,
        coordinator_agent TEXT NOT NULL,
        project_path TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        task TEXT NOT NULL,
        status TEXT NOT NULL,
        round INTEGER NOT NULL DEFAULT 0,
        max_rounds INTEGER NOT NULL,
        codex_session_id TEXT,
        latest_response TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS orchestration_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES orchestration_runs(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_orchestration_events_run
        ON orchestration_events (run_id, id);

      CREATE TABLE IF NOT EXISTS wake_targets (
        agent TEXT PRIMARY KEY, target TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wake_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL REFERENCES messages(id),
        agent TEXT NOT NULL, target TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', attempt_id TEXT,
        attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL, detail TEXT NOT NULL DEFAULT '',
        UNIQUE(message_id, agent)
      );
      CREATE INDEX IF NOT EXISTS wake_jobs_due ON wake_jobs(state, retry_at);
    `);
  },

  // v2: agent lifecycle, delivery follow-up, durable background runs and housekeeping.
  (db) => {
    addColumn(db, "agents", "retired_at", "TEXT");
    addColumn(db, "agents", "retired_by", "TEXT");
    addColumn(db, "agents", "retire_note", "TEXT");
    addColumn(db, "acknowledgements", "note", "TEXT");
    addColumn(db, "wake_jobs", "pending_reason", "TEXT");
    addColumn(db, "wake_jobs", "notified_at", "INTEGER");
    for (const [column, definition] of [
      ["sandbox_mode", "TEXT"],
      ["base_commit", "TEXT"],
      ["branch", "TEXT"],
      ["owner_pid", "INTEGER"],
      ["owner_started", "TEXT"],
      ["child_pid", "INTEGER"],
      ["child_started", "TEXT"],
      ["turn_files", "TEXT"],
      ["turn_started_at", "TEXT"],
      ["delivered_round", "INTEGER NOT NULL DEFAULT 0"],
    ] as const) {
      addColumn(db, "orchestration_runs", column, definition);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS channel_hosts (
        session_id TEXT PRIMARY KEY, pid INTEGER NOT NULL, heartbeat INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_from ON messages (from_agent, id);
      CREATE INDEX IF NOT EXISTS idx_orchestration_runs_status ON orchestration_runs (status);
      CREATE INDEX IF NOT EXISTS wake_jobs_unnotified ON wake_jobs (state) WHERE notified_at IS NULL;
    `);
    // Earlier deliveries finished before sender notices existed. Never replay
    // them as a burst of new notices.
    db.prepare(
      `UPDATE wake_jobs SET notified_at = ?
       WHERE notified_at IS NULL AND state IN ('refused', 'expired', 'held')`,
    ).run(Date.now());
    // Runs created before v2 were already returned to their coordinator.
    db.exec("UPDATE orchestration_runs SET delivered_round = round WHERE delivered_round < round");
  },
];

export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number | bigint };
  return Number(row.user_version);
}

function hasExistingData(db: DatabaseSync): boolean {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'messages'")
    .get() as { n: number | bigint };
  return Number(row.n) > 0;
}

export interface MigrationResult {
  from: number;
  to: number;
  /** A newer bridge already migrated this database further than this build knows. */
  newer: boolean;
}

/**
 * Bring the database to SCHEMA_VERSION. `beforeUpgrade` runs outside any
 * transaction when an existing database is about to change, so callers can
 * take a backup first.
 */
export function migrate(
  db: DatabaseSync,
  beforeUpgrade?: (fromVersion: number) => void,
): MigrationResult {
  const initial = schemaVersion(db);
  if (initial >= SCHEMA_VERSION) {
    return { from: initial, to: initial, newer: initial > SCHEMA_VERSION };
  }
  if (hasExistingData(db)) beforeUpgrade?.(initial);

  db.exec("BEGIN IMMEDIATE");
  try {
    // Re-read under the write lock: another process may have migrated already.
    const locked = schemaVersion(db);
    for (let version = locked; version < SCHEMA_VERSION; version += 1) {
      MIGRATIONS[version](db);
    }
    if (locked < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { from: initial, to: SCHEMA_VERSION, newer: false };
}
