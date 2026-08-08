import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** A message as stored and returned by the bridge. */
export interface BridgeMessage {
  id: number;
  fromAgent: string;
  toAgent: string;
  body: string;
  threadId: string | null;
  idempotencyKey: string | null;
  createdAt: string;
}

/** A registered agent and its advertised capabilities. */
export interface BridgeAgent {
  name: string;
  capabilities: string[];
  registeredAt: string;
  lastSeen: string;
}

export type OrchestrationStatus =
  | "created"
  | "running_codex"
  | "waiting_for_fable"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled";

export interface OrchestrationRun {
  id: string;
  coordinatorAgent: string;
  projectPath: string;
  worktreePath: string;
  threadId: string;
  task: string;
  status: OrchestrationStatus;
  round: number;
  maxRounds: number;
  codexSessionId: string | null;
  latestResponse: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRunInput {
  id: string;
  coordinatorAgent: string;
  projectPath: string;
  worktreePath: string;
  threadId: string;
  task: string;
  status: OrchestrationStatus;
  maxRounds: number;
}

export interface RunEvent {
  id: number;
  runId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface SendInput {
  fromAgent: string;
  toAgent: string;
  body: string;
  threadId?: string | null;
  idempotencyKey?: string | null;
}

export interface InboxOptions {
  includeAcknowledged?: boolean;
}

/** Wildcard recipient: delivered to every agent except the sender. */
const BROADCAST = "*";

interface MessageRow {
  id: number | bigint;
  from_agent: string;
  to_agent: string;
  body: string;
  thread_id: string | null;
  idempotency_key: string | null;
  created_at: string;
}

interface AgentRow {
  name: string;
  capabilities: string;
  registered_at: string;
  last_seen: string;
}

interface RunRow {
  id: string;
  coordinator_agent: string;
  project_path: string;
  worktree_path: string;
  thread_id: string;
  task: string;
  status: OrchestrationStatus;
  round: number | bigint;
  max_rounds: number | bigint;
  codex_session_id: string | null;
  latest_response: string | null;
  created_at: string;
  updated_at: string;
}

interface RunEventRow {
  id: number | bigint;
  run_id: string;
  event_type: string;
  payload: string;
  created_at: string;
}

/**
 * SQLite-backed mailbox shared between agents. All state lives in a single
 * database file so multiple processes (Claude, Codex, ...) coordinate through
 * the same store.
 */
export class BridgeStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
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
    `);
  }

  private now(): string {
    return new Date().toISOString();
  }

  private toMessage(row: MessageRow): BridgeMessage {
    return {
      id: Number(row.id),
      fromAgent: row.from_agent,
      toAgent: row.to_agent,
      body: row.body,
      threadId: row.thread_id,
      idempotencyKey: row.idempotency_key,
      createdAt: row.created_at,
    };
  }

  /**
   * Deliver a message. When an idempotency key is supplied and a message with
   * the same (fromAgent, idempotencyKey) already exists, the original message
   * is returned instead of creating a duplicate.
   */
  send(input: SendInput): BridgeMessage {
    const threadId = input.threadId ?? null;
    const idempotencyKey = input.idempotencyKey ?? null;

    if (idempotencyKey !== null) {
      const existing = this.db
        .prepare(
          "SELECT * FROM messages WHERE from_agent = ? AND idempotency_key = ?",
        )
        .get(input.fromAgent, idempotencyKey) as unknown as
        | MessageRow
        | undefined;
      if (existing) {
        return this.toMessage(existing);
      }
    }

    const createdAt = this.now();
    const result = this.db
      .prepare(
        `INSERT INTO messages (from_agent, to_agent, body, thread_id, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.fromAgent,
        input.toAgent,
        input.body,
        threadId,
        idempotencyKey,
        createdAt,
      );

    const row = this.db
      .prepare("SELECT * FROM messages WHERE id = ?")
      .get(Number(result.lastInsertRowid)) as unknown as MessageRow;
    return this.toMessage(row);
  }

  /**
   * Messages addressed to `agent` (directly or by broadcast) that the agent
   * has not acknowledged. Broadcasts never appear in the sender's own inbox.
   */
  inbox(agent: string, options: InboxOptions = {}): BridgeMessage[] {
    const includeAcknowledged = options.includeAcknowledged ?? false;
    const ackFilter = includeAcknowledged
      ? ""
      : `AND NOT EXISTS (
           SELECT 1 FROM acknowledgements a
           WHERE a.message_id = m.id AND a.agent = ?
         )`;

    const sql = `
      SELECT m.* FROM messages m
      WHERE (m.to_agent = ? OR (m.to_agent = ? AND m.from_agent != ?))
      ${ackFilter}
      ORDER BY m.id ASC`;

    const params = includeAcknowledged
      ? [agent, BROADCAST, agent]
      : [agent, BROADCAST, agent, agent];

    const rows = this.db.prepare(sql).all(...params) as unknown as MessageRow[];
    return rows.map((row) => this.toMessage(row));
  }

  /**
   * Mark messages as acknowledged by `agent`. Returns the number of messages
   * newly acknowledged (already-acknowledged ids are ignored).
   */
  ack(agent: string, messageIds: number[]): number {
    // Only messages actually delivered to this agent may be acknowledged:
    // a direct message addressed to it, or a broadcast it did not send. The
    // guard mirrors the delivery rule in inbox().
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO acknowledgements (message_id, agent, acked_at)
       SELECT m.id, ?, ?
       FROM messages m
       WHERE m.id = ?
         AND (m.to_agent = ? OR (m.to_agent = ? AND m.from_agent != ?))`,
    );
    const ackedAt = this.now();
    let acknowledged = 0;
    for (const id of messageIds) {
      const result = stmt.run(agent, ackedAt, id, agent, BROADCAST, agent);
      acknowledged += Number(result.changes);
    }
    return acknowledged;
  }

  /** All messages in a conversation thread, oldest first. */
  thread(threadId: string): BridgeMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY id ASC")
      .all(threadId) as unknown as MessageRow[];
    return rows.map((row) => this.toMessage(row));
  }

  /** Register or refresh an agent's presence and advertised capabilities. */
  register(name: string, capabilities: string[] = []): BridgeAgent {
    const now = this.now();
    const serialized = JSON.stringify(capabilities);
    this.db
      .prepare(
        `INSERT INTO agents (name, capabilities, registered_at, last_seen)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           capabilities = excluded.capabilities,
           last_seen = excluded.last_seen`,
      )
      .run(name, serialized, now, now);

    const row = this.db
      .prepare("SELECT * FROM agents WHERE name = ?")
      .get(name) as unknown as AgentRow;
    return this.toAgent(row);
  }

  private toAgent(row: AgentRow): BridgeAgent {
    return {
      name: row.name,
      capabilities: JSON.parse(row.capabilities) as string[],
      registeredAt: row.registered_at,
      lastSeen: row.last_seen,
    };
  }

  /** All registered agents, in registration order. */
  agents(): BridgeAgent[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM agents ORDER BY registered_at ASC, name ASC",
      )
      .all() as unknown as AgentRow[];
    return rows.map((row) => this.toAgent(row));
  }

  createRun(input: CreateRunInput): OrchestrationRun {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO orchestration_runs (
           id, coordinator_agent, project_path, worktree_path, thread_id, task,
           status, round, max_rounds, codex_session_id, latest_response,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, ?, ?)`,
      )
      .run(
        input.id,
        input.coordinatorAgent,
        input.projectPath,
        input.worktreePath,
        input.threadId,
        input.task,
        input.status,
        input.maxRounds,
        now,
        now,
      );
    return this.getRun(input.id) as OrchestrationRun;
  }

  private toRun(row: RunRow): OrchestrationRun {
    return {
      id: row.id,
      coordinatorAgent: row.coordinator_agent,
      projectPath: row.project_path,
      worktreePath: row.worktree_path,
      threadId: row.thread_id,
      task: row.task,
      status: row.status,
      round: Number(row.round),
      maxRounds: Number(row.max_rounds),
      codexSessionId: row.codex_session_id,
      latestResponse: row.latest_response
        ? (JSON.parse(row.latest_response) as Record<string, unknown>)
        : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getRun(id: string): OrchestrationRun | undefined {
    const row = this.db
      .prepare("SELECT * FROM orchestration_runs WHERE id = ?")
      .get(id) as unknown as RunRow | undefined;
    return row ? this.toRun(row) : undefined;
  }

  updateRun(
    id: string,
    patch: Partial<
      Pick<
        OrchestrationRun,
        "status" | "round" | "codexSessionId" | "latestResponse" | "worktreePath"
      >
    >,
  ): OrchestrationRun {
    const current = this.getRun(id);
    if (!current) throw new Error(`Unknown orchestration run: ${id}`);
    const merged = { ...current, ...patch, updatedAt: this.now() };
    this.db
      .prepare(
        `UPDATE orchestration_runs
         SET status = ?, round = ?, codex_session_id = ?, latest_response = ?,
             worktree_path = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        merged.status,
        merged.round,
        merged.codexSessionId,
        merged.latestResponse === null ? null : JSON.stringify(merged.latestResponse),
        merged.worktreePath,
        merged.updatedAt,
        id,
      );
    return this.getRun(id) as OrchestrationRun;
  }

  appendRunEvent(
    runId: string,
    type: string,
    payload: Record<string, unknown>,
  ): RunEvent {
    const createdAt = this.now();
    const result = this.db
      .prepare(
        `INSERT INTO orchestration_events (run_id, event_type, payload, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(runId, type, JSON.stringify(payload), createdAt);
    const row = this.db
      .prepare("SELECT * FROM orchestration_events WHERE id = ?")
      .get(Number(result.lastInsertRowid)) as unknown as RunEventRow;
    return {
      id: Number(row.id),
      runId: row.run_id,
      type: row.event_type,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      createdAt: row.created_at,
    };
  }

  runEvents(runId: string): RunEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM orchestration_events WHERE run_id = ? ORDER BY id ASC")
      .all(runId) as unknown as RunEventRow[];
    return rows.map((row) => ({
      id: Number(row.id),
      runId: row.run_id,
      type: row.event_type,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      createdAt: row.created_at,
    }));
  }

  close(): void {
    this.db.close();
  }
}
