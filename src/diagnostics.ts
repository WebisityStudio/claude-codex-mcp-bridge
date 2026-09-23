import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { modeString } from "./fs-safety.js";

export interface BacklogEntry {
  agent: string;
  unread: number;
  lastActivity: string | null;
  retired: boolean;
  registered: boolean;
}

export interface DatabaseReport {
  path: string;
  exists: boolean;
  mode: string | null;
  sizeBytes: number | null;
  schemaVersion: number | null;
  quickCheck: string | null;
  messages: number;
  unreadDirect: number;
  agents: number;
  retiredAgents: number;
  backlog: BacklogEntry[];
  wakeLastWeek: Array<{ app: string; state: string; count: number }>;
  runs: Record<string, number>;
  latestDailyBackup: string | null;
  error?: string;
}

type Row = Record<string, string | number | bigint | null>;

function count(db: DatabaseSync, sql: string, ...params: Array<string | number>): number {
  const row = db.prepare(sql).get(...params) as Row | undefined;
  return row ? Number(Object.values(row)[0] ?? 0) : 0;
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).some((row) => row.name === column);
}

export function latestDailyBackup(backupDir: string): string | null {
  try {
    const names = readdirSync(backupDir).filter((name) => /^bridge-daily-\d{4}-\d{2}-\d{2}\.sqlite$/.test(name));
    return names.sort().at(-1) ?? null;
  } catch {
    return null;
  }
}

/**
 * Inspect the mailbox through a read-only connection. Never migrates, never
 * writes, and tolerates any schema version from 0.3.0 onwards.
 */
export function inspectDatabase(path: string, now = Date.now()): DatabaseReport {
  const report: DatabaseReport = {
    path,
    exists: existsSync(path),
    mode: modeString(path),
    sizeBytes: existsSync(path) ? statSync(path).size : null,
    schemaVersion: null,
    quickCheck: null,
    messages: 0,
    unreadDirect: 0,
    agents: 0,
    retiredAgents: 0,
    backlog: [],
    wakeLastWeek: [],
    runs: {},
    latestDailyBackup: latestDailyBackup(join(path, "..", "backups")),
  };
  if (!report.exists) return report;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000;");
    report.schemaVersion = count(db, "PRAGMA user_version");
    report.quickCheck = String((db.prepare("PRAGMA quick_check").get() as Row).quick_check);
    report.messages = count(db, "SELECT COUNT(*) FROM messages");
    const unacked = `m.to_agent != '*' AND NOT EXISTS (
      SELECT 1 FROM acknowledgements a WHERE a.message_id = m.id AND a.agent = m.to_agent)`;
    report.unreadDirect = count(db, `SELECT COUNT(*) FROM messages m WHERE ${unacked}`);
    const retirement = hasColumn(db, "agents", "retired_at");
    report.agents = count(db, `SELECT COUNT(*) FROM agents${retirement ? " WHERE retired_at IS NULL" : ""}`);
    report.retiredAgents = retirement ? count(db, "SELECT COUNT(*) FROM agents WHERE retired_at IS NOT NULL") : 0;
    const rows = db
      .prepare(
        `SELECT m.to_agent AS agent, COUNT(*) AS unread,
           (SELECT MAX(last_seen,
              COALESCE((SELECT MAX(created_at) FROM messages WHERE from_agent = m.to_agent), ''),
              COALESCE((SELECT MAX(acked_at) FROM acknowledgements WHERE agent = m.to_agent), ''))
            FROM agents WHERE name = m.to_agent) AS last_activity,
           ${retirement ? "(SELECT retired_at FROM agents WHERE name = m.to_agent)" : "NULL"} AS retired_at,
           EXISTS (SELECT 1 FROM agents WHERE name = m.to_agent) AS registered
         FROM messages m WHERE ${unacked}
         GROUP BY m.to_agent ORDER BY unread DESC LIMIT 12`,
      )
      .all() as Row[];
    report.backlog = rows.map((row) => ({
      agent: String(row.agent),
      unread: Number(row.unread),
      lastActivity: row.last_activity === null ? null : String(row.last_activity),
      retired: row.retired_at !== null,
      registered: Number(row.registered) === 1,
    }));
    report.wakeLastWeek = (
      db
        .prepare(
          `SELECT json_extract(target, '$.app') AS app, state, COUNT(*) AS n FROM wake_jobs
           WHERE created_at >= ? GROUP BY app, state ORDER BY app, n DESC`,
        )
        .all(now - 7 * 24 * 3_600_000) as Row[]
    ).map((row) => ({ app: String(row.app), state: String(row.state), count: Number(row.n) }));
    report.runs = Object.fromEntries(
      (db.prepare("SELECT status, COUNT(*) AS n FROM orchestration_runs GROUP BY status").all() as Row[]).map((row) => [
        String(row.status),
        Number(row.n),
      ]),
    );
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    db?.close();
  }
  return report;
}

/** Claude Code's crossSessionInbound value from user settings, read-only. */
export function crossSessionInbound(home = homedir()): string | null {
  try {
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")) as Record<string, unknown>;
    const value = settings.crossSessionInbound;
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}
