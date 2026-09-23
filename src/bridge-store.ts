import { WakeQueue } from "./wake-queue.js";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { DATA_DIR_NAME, ensurePrivateDirectory, restrictToOwner } from "./fs-safety.js";
import { clampLimit, fitMessages, type FitOptions, type MessageView } from "./paging.js";
import { migrate, SCHEMA_VERSION, type MigrationResult } from "./schema.js";

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
  retiredAt: string | null;
  retiredBy: string | null;
  retireNote: string | null;
}

export interface AgentSummary extends BridgeAgent {
  unread: number;
  /** Latest of registration refresh, sent message or acknowledgement. */
  lastActivity: string;
}

export type OrchestrationStatus =
  | "created"
  | "running_codex"
  | "waiting_for_fable"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled";

export type SandboxMode = "read-only" | "workspace-write";

/** Files a detached Codex turn writes, so any bridge process can finish it. */
export interface TurnFiles {
  outputPath: string;
  eventsPath: string;
  stderrPath: string;
}

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
  sandboxMode: SandboxMode;
  baseCommit: string | null;
  branch: string | null;
  ownerPid: number | null;
  ownerStarted: string | null;
  childPid: number | null;
  childStarted: string | null;
  turnFiles: TurnFiles | null;
  turnStartedAt: string | null;
  deliveredRound: number;
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
  sandboxMode?: SandboxMode;
  baseCommit?: string | null;
  branch?: string | null;
  ownerPid?: number | null;
  ownerStarted?: string | null;
}

export type RunPatch = Partial<
  Pick<
    OrchestrationRun,
    | "status"
    | "round"
    | "codexSessionId"
    | "latestResponse"
    | "worktreePath"
    | "ownerPid"
    | "ownerStarted"
    | "childPid"
    | "childStarted"
    | "turnFiles"
    | "turnStartedAt"
  >
>;

export interface RunEvent {
  id: number;
  runId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface SendInput {
  wake?: boolean;
  fromAgent: string;
  toAgent: string;
  body: string;
  threadId?: string | null;
  idempotencyKey?: string | null;
}

export interface InboxOptions {
  includeAcknowledged?: boolean;
  fromAgent?: string;
  threadId?: string;
  afterId?: number;
  limit?: number;
}

export interface InboxPage {
  count: number;
  totalUnread: number;
  hasMore: boolean;
  nextAfterId: number | null;
  messages: MessageView[];
}

export interface ThreadPageOptions extends FitOptions {
  afterId?: number;
  beforeId?: number;
  limit?: number;
}

export interface ThreadPage {
  threadId: string;
  total: number;
  count: number;
  olderBeforeId: number | null;
  newerAfterId: number | null;
  messages: MessageView[];
}

export interface OutboxEntry {
  id: number;
  toAgent: string;
  threadId: string | null;
  createdAt: string;
  preview: string;
  bodyLength: number;
  acknowledgedAt: string | null;
  wake: { state: string; detail: string } | null;
  recipient: "active" | "retired" | "unknown";
}

export interface RetireInput {
  by: string;
  note?: string;
  closeBacklog?: boolean;
}

export interface RetireRecord {
  agent: BridgeAgent;
  unbound: boolean;
  closed: number;
  bySender: Array<{ fromAgent: string; count: number; messageIds: number[] }>;
}

export interface BridgeStoreOptions {
  /** Where pre-migration and daily backups go. Defaults to `<db dir>/backups`. */
  backupDir?: string;
}

/** Wildcard recipient: delivered to every agent except the sender. */
const BROADCAST = "*";

type Param = string | number | null;

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
  retired_at: string | null;
  retired_by: string | null;
  retire_note: string | null;
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
  sandbox_mode: string | null;
  base_commit: string | null;
  branch: string | null;
  owner_pid: number | bigint | null;
  owner_started: string | null;
  child_pid: number | bigint | null;
  child_started: string | null;
  turn_files: string | null;
  turn_started_at: string | null;
  delivered_round: number | bigint;
}

interface RunEventRow {
  id: number | bigint;
  run_id: string;
  event_type: string;
  payload: string;
  created_at: string;
}

/**
 * Delivery rule, used everywhere a message's recipients are decided: direct
 * messages to the agent, plus broadcasts from others sent after it registered
 * (late joiners do not inherit old broadcasts; unregistered readers see all).
 * Placeholder form binds the agent three times.
 */
const DELIVERED_TO = (agentColumn: string) => `
  (m.to_agent = ${agentColumn} OR (
    m.to_agent = '${BROADCAST}' AND m.from_agent != ${agentColumn}
    AND m.created_at >= COALESCE((SELECT registered_at FROM agents r WHERE r.name = ${agentColumn}), '')
  ))`;

const UNREAD_FOR = (agentColumn: string) => `
  ${DELIVERED_TO(agentColumn)}
  AND NOT EXISTS (
    SELECT 1 FROM acknowledgements a WHERE a.message_id = m.id AND a.agent = ${agentColumn}
  )`;

/** Bindings for DELIVERED_TO("?") and UNREAD_FOR("?"), which name the agent 3 and 4 times. */
const deliveredParams = (agent: string): Param[] => [agent, agent, agent];
const unreadParams = (agent: string): Param[] => [agent, agent, agent, agent];

function optionalNumber(value: number | bigint | null): number | null {
  return value === null ? null : Number(value);
}

/**
 * SQLite-backed mailbox shared between agents. All state lives in a single
 * database file so multiple processes (Claude, Codex, ...) coordinate through
 * the same store.
 */
export class BridgeStore {
  private readonly db: DatabaseSync;
  readonly wakes: WakeQueue;
  readonly dbPath: string;
  readonly backupDir: string | null;
  readonly migration: MigrationResult;

  constructor(dbPath: string, options: BridgeStoreOptions = {}) {
    this.dbPath = dbPath;
    const inMemory = dbPath === ":memory:";
    this.backupDir = inMemory ? null : options.backupDir ?? join(dirname(dbPath), "backups");
    if (!inMemory) {
      const directory = dirname(dbPath);
      // Tighten our own data directory; a caller-chosen directory keeps its mode.
      if (basename(directory) === DATA_DIR_NAME) ensurePrivateDirectory(directory);
      else mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.migration = migrate(this.db, (from) => this.backupBeforeMigration(from));
    if (!inMemory) this.restrictDatabaseFiles();
    this.wakes = new WakeQueue(this.db, dbPath);
  }

  /** Messages and history are private working data: keep them owner-only. */
  restrictDatabaseFiles(): void {
    for (const suffix of ["", "-wal", "-shm"]) restrictToOwner(`${this.dbPath}${suffix}`);
  }

  private backupBeforeMigration(fromVersion: number): void {
    if (!this.backupDir) return;
    ensurePrivateDirectory(this.backupDir);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = join(
      this.backupDir,
      `bridge-pre-v${SCHEMA_VERSION}-from-v${fromVersion}-${stamp}-${process.pid}.sqlite`,
    );
    try {
      this.backupTo(target);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Refusing to migrate without a backup (${target}): ${reason}`);
    }
  }

  /** Consistent point-in-time copy, safe while other processes write. */
  backupTo(path: string): void {
    this.db.prepare("VACUUM INTO ?").run(path);
    restrictToOwner(path);
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
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const message = this.insertMessage(input);
      this.db.exec("COMMIT");
      return message;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private insertMessage(input: SendInput): BridgeMessage {
    const threadId = input.threadId ?? null;
    const idempotencyKey = input.idempotencyKey ?? null;

    if (idempotencyKey !== null) {
      const existing = this.db
        .prepare("SELECT * FROM messages WHERE from_agent = ? AND idempotency_key = ?")
        .get(input.fromAgent, idempotencyKey) as unknown as MessageRow | undefined;
      if (existing) return this.toMessage(existing);
    }

    const result = this.db
      .prepare(
        `INSERT INTO messages (from_agent, to_agent, body, thread_id, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.fromAgent, input.toAgent, input.body, threadId, idempotencyKey, this.now());

    const message = this.messageById(Number(result.lastInsertRowid)) as BridgeMessage;
    if (input.wake !== false) this.wakes.enqueue(message);
    return message;
  }

  messageById(id: number): BridgeMessage | undefined {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as unknown as
      | MessageRow
      | undefined;
    return row ? this.toMessage(row) : undefined;
  }

  /**
   * Messages addressed to `agent` (directly or by broadcast), oldest first.
   * Unacknowledged only unless `includeAcknowledged`. Broadcasts never appear
   * in the sender's own inbox.
   */
  inbox(agent: string, options: InboxOptions = {}): BridgeMessage[] {
    const clauses = [DELIVERED_TO("?")];
    const params: Param[] = deliveredParams(agent);
    if (!options.includeAcknowledged) {
      clauses.push(
        "NOT EXISTS (SELECT 1 FROM acknowledgements a WHERE a.message_id = m.id AND a.agent = ?)",
      );
      params.push(agent);
    }
    if (options.fromAgent) {
      clauses.push("m.from_agent = ?");
      params.push(options.fromAgent);
    }
    if (options.threadId) {
      clauses.push("m.thread_id = ?");
      params.push(options.threadId);
    }
    if (options.afterId !== undefined) {
      clauses.push("m.id > ?");
      params.push(options.afterId);
    }
    let sql = `SELECT m.* FROM messages m WHERE ${clauses.join(" AND ")} ORDER BY m.id ASC`;
    if (options.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(options.limit);
    }
    const rows = this.db.prepare(sql).all(...params) as unknown as MessageRow[];
    return rows.map((row) => this.toMessage(row));
  }

  countUnread(agent: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM messages m WHERE ${UNREAD_FOR("?")}`)
      .get(...unreadParams(agent)) as { n: number | bigint };
    return Number(row.n);
  }

  /** A bounded inbox read that always fits comfortably inside an MCP result. */
  inboxPage(agent: string, options: InboxOptions & FitOptions = {}): InboxPage {
    const limit = clampLimit(options.limit);
    const rows = this.inbox(agent, { ...options, limit: limit + 1 });
    const fitted = fitMessages(rows.slice(0, limit), options);
    const hasMore = rows.length > limit || fitted.omitted > 0;
    const last = fitted.messages.at(-1);
    return {
      count: fitted.messages.length,
      totalUnread: this.countUnread(agent),
      hasMore,
      nextAfterId: hasMore && last ? last.id : null,
      messages: fitted.messages,
    };
  }

  /**
   * Mark messages as acknowledged by `agent`. Returns the number of messages
   * newly acknowledged (already-acknowledged ids are ignored).
   */
  ack(agent: string, messageIds: number[], note: string | null = null): number {
    // Only messages actually delivered to this agent may be acknowledged:
    // a direct message addressed to it, or a broadcast it did not send. The
    // guard mirrors the delivery rule in inbox().
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO acknowledgements (message_id, agent, acked_at, note)
       SELECT m.id, ?, ?, ?
       FROM messages m
       WHERE m.id = ? AND ${DELIVERED_TO("?")}`,
    );
    const ackedAt = this.now();
    let acknowledged = 0;
    for (const id of messageIds) {
      const result = stmt.run(agent, ackedAt, note, id, ...deliveredParams(agent));
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

  /**
   * One page of a thread. Without a cursor it returns the most recent
   * messages; `beforeId` pages backwards and `afterId` pages forwards.
   */
  threadPage(threadId: string, options: ThreadPageOptions = {}): ThreadPage {
    const limit = clampLimit(options.limit, 30);
    let messages: MessageView[];
    if (options.afterId !== undefined) {
      const rows = this.db
        .prepare("SELECT * FROM messages WHERE thread_id = ? AND id > ? ORDER BY id ASC LIMIT ?")
        .all(threadId, options.afterId, limit) as unknown as MessageRow[];
      messages = fitMessages(rows.map((row) => this.toMessage(row)), options).messages;
    } else {
      const before = options.beforeId ?? Number.MAX_SAFE_INTEGER;
      const rows = this.db
        .prepare("SELECT * FROM messages WHERE thread_id = ? AND id < ? ORDER BY id DESC LIMIT ?")
        .all(threadId, before, limit) as unknown as MessageRow[];
      // Spend the budget on the newest messages, then present oldest first.
      messages = fitMessages(rows.map((row) => this.toMessage(row)), options).messages.reverse();
    }
    const exists = (sql: string, id: number) =>
      this.db.prepare(sql).get(threadId, id) !== undefined;
    const first = messages[0];
    const last = messages.at(-1);
    const total = this.db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?")
      .get(threadId) as { n: number | bigint };
    return {
      threadId,
      total: Number(total.n),
      count: messages.length,
      olderBeforeId:
        first && exists("SELECT 1 FROM messages WHERE thread_id = ? AND id < ? LIMIT 1", first.id)
          ? first.id
          : null,
      newerAfterId:
        last && exists("SELECT 1 FROM messages WHERE thread_id = ? AND id > ? LIMIT 1", last.id)
          ? last.id
          : null,
      messages,
    };
  }

  /** Direct messages `agent` sent, newest first, with the recipient's handling state. */
  outbox(
    agent: string,
    options: { includeAcknowledged?: boolean; limit?: number } = {},
  ): { totalUnacknowledged: number; hasMore: boolean; entries: OutboxEntry[] } {
    const limit = clampLimit(options.limit, 30);
    const ackFilter = options.includeAcknowledged ? "" : "AND a.acked_at IS NULL";
    const rows = this.db
      .prepare(
        `SELECT m.id, m.to_agent, m.thread_id, m.created_at, substr(m.body, 1, 200) AS preview,
                length(m.body) AS body_length, a.acked_at, w.state AS wake_state,
                w.detail AS wake_detail, r.name AS recipient_name, r.retired_at AS recipient_retired
         FROM messages m
         LEFT JOIN acknowledgements a ON a.message_id = m.id AND a.agent = m.to_agent
         LEFT JOIN wake_jobs w ON w.message_id = m.id AND w.agent = m.to_agent
         LEFT JOIN agents r ON r.name = m.to_agent
         WHERE m.from_agent = ? AND m.to_agent != ? ${ackFilter}
         ORDER BY m.id DESC LIMIT ?`,
      )
      .all(agent, BROADCAST, limit + 1) as Array<Record<string, string | number | bigint | null>>;
    const total = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages m
         WHERE m.from_agent = ? AND m.to_agent != ? AND NOT EXISTS (
           SELECT 1 FROM acknowledgements a WHERE a.message_id = m.id AND a.agent = m.to_agent
         )`,
      )
      .get(agent, BROADCAST) as { n: number | bigint };
    return {
      totalUnacknowledged: Number(total.n),
      hasMore: rows.length > limit,
      entries: rows.slice(0, limit).map((row) => ({
        id: Number(row.id),
        toAgent: row.to_agent as string,
        threadId: row.thread_id as string | null,
        createdAt: row.created_at as string,
        preview: row.preview as string,
        bodyLength: Number(row.body_length),
        acknowledgedAt: row.acked_at as string | null,
        wake:
          row.wake_state === null
            ? null
            : { state: row.wake_state as string, detail: row.wake_detail as string },
        recipient:
          row.recipient_name === null ? "unknown" : row.recipient_retired ? "retired" : "active",
      })),
    };
  }

  /**
   * Register or refresh an agent's presence. Omitted capabilities keep the
   * existing list. Registering again reactivates a retired agent.
   */
  register(name: string, capabilities?: string[]): BridgeAgent {
    const now = this.now();
    const existing = this.getAgent(name);
    const serialized = JSON.stringify(capabilities ?? existing?.capabilities ?? []);
    this.db
      .prepare(
        `INSERT INTO agents (name, capabilities, registered_at, last_seen)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           capabilities = excluded.capabilities,
           last_seen = excluded.last_seen,
           retired_at = NULL, retired_by = NULL, retire_note = NULL`,
      )
      .run(name, serialized, now, now);
    return this.getAgent(name) as BridgeAgent;
  }

  getAgent(name: string): BridgeAgent | undefined {
    const row = this.db.prepare("SELECT * FROM agents WHERE name = ?").get(name) as unknown as
      | AgentRow
      | undefined;
    return row ? this.toAgent(row) : undefined;
  }

  /** Record activity for a registered agent. Unknown names are ignored. */
  touch(name: string): void {
    this.db.prepare("UPDATE agents SET last_seen = ? WHERE name = ?").run(this.now(), name);
  }

  /** Latest of registration refresh, sent message or acknowledgement, if registered. */
  lastActivity(name: string): string | null {
    const row = this.db
      .prepare(
        `SELECT MAX(ag.last_seen,
             COALESCE((SELECT MAX(created_at) FROM messages WHERE from_agent = ag.name), ''),
             COALESCE((SELECT MAX(acked_at) FROM acknowledgements WHERE agent = ag.name), '')
           ) AS last_activity
         FROM agents ag WHERE ag.name = ?`,
      )
      .get(name) as { last_activity: string } | undefined;
    return row?.last_activity ?? null;
  }

  private toAgent(row: AgentRow): BridgeAgent {
    return {
      name: row.name,
      capabilities: JSON.parse(row.capabilities) as string[],
      registeredAt: row.registered_at,
      lastSeen: row.last_seen,
      retiredAt: row.retired_at ?? null,
      retiredBy: row.retired_by ?? null,
      retireNote: row.retire_note ?? null,
    };
  }

  /** Registered agents in registration order. Retired agents are hidden by default. */
  agents(options: { includeRetired?: boolean } = {}): BridgeAgent[] {
    const filter = options.includeRetired ? "" : "WHERE retired_at IS NULL";
    const rows = this.db
      .prepare(`SELECT * FROM agents ${filter} ORDER BY registered_at ASC, name ASC`)
      .all() as unknown as AgentRow[];
    return rows.map((row) => this.toAgent(row));
  }

  /** Agents with unread counts and their latest observable activity. */
  agentSummaries(options: { includeRetired?: boolean } = {}): AgentSummary[] {
    const filter = options.includeRetired ? "" : "WHERE ag.retired_at IS NULL";
    const rows = this.db
      .prepare(
        `SELECT ag.*,
           (SELECT COUNT(*) FROM messages m WHERE ${UNREAD_FOR("ag.name")}) AS unread,
           MAX(ag.last_seen,
               COALESCE((SELECT MAX(created_at) FROM messages WHERE from_agent = ag.name), ''),
               COALESCE((SELECT MAX(acked_at) FROM acknowledgements WHERE agent = ag.name), '')
           ) AS last_activity
         FROM agents ag ${filter}
         ORDER BY ag.registered_at ASC, ag.name ASC`,
      )
      .all() as unknown as Array<AgentRow & { unread: number | bigint; last_activity: string }>;
    return rows.map((row) => ({
      ...this.toAgent(row),
      unread: Number(row.unread),
      lastActivity: row.last_activity,
    }));
  }

  /**
   * Retire an agent: stop pings, and optionally close its unhandled backlog.
   * Closed messages keep their history; the acknowledgement records why.
   */
  retire(name: string, input: RetireInput): RetireRecord {
    const agent = this.getAgent(name);
    if (!agent) throw new Error(`Unknown agent: ${name}`);
    const closeBacklog = input.closeBacklog ?? true;
    const now = this.now();
    const note = `Closed unhandled when ${name} was retired by ${input.by}${input.note ? `: ${input.note}` : ""}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("UPDATE agents SET retired_at = ?, retired_by = ?, retire_note = ? WHERE name = ?")
        .run(now, input.by, input.note ?? null, name);
      const unbound = this.wakes.target(name) !== null;
      if (unbound) this.wakes.bind(name, null);
      const backlog = closeBacklog
        ? (this.db
            .prepare(`SELECT m.id, m.from_agent FROM messages m WHERE ${UNREAD_FOR("?")} ORDER BY m.id`)
            .all(...unreadParams(name)) as Array<{ id: number | bigint; from_agent: string }>)
        : [];
      const close = this.db.prepare(
        "INSERT OR IGNORE INTO acknowledgements (message_id, agent, acked_at, note) VALUES (?, ?, ?, ?)",
      );
      const bySender = new Map<string, number[]>();
      for (const row of backlog) {
        close.run(Number(row.id), name, now, note);
        bySender.set(row.from_agent, [...(bySender.get(row.from_agent) ?? []), Number(row.id)]);
      }
      this.db.exec("COMMIT");
      return {
        agent: this.getAgent(name) as BridgeAgent,
        unbound,
        closed: backlog.length,
        bySender: [...bySender].map(([fromAgent, messageIds]) => ({
          fromAgent,
          count: messageIds.length,
          messageIds,
        })),
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  createRun(input: CreateRunInput): OrchestrationRun {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO orchestration_runs (
           id, coordinator_agent, project_path, worktree_path, thread_id, task,
           status, round, max_rounds, codex_session_id, latest_response,
           created_at, updated_at, sandbox_mode, base_commit, branch, owner_pid, owner_started
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`,
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
        input.sandboxMode ?? "workspace-write",
        input.baseCommit ?? null,
        input.branch ?? null,
        input.ownerPid ?? null,
        input.ownerStarted ?? null,
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
      sandboxMode: row.sandbox_mode === "read-only" ? "read-only" : "workspace-write",
      baseCommit: row.base_commit ?? null,
      branch: row.branch ?? null,
      ownerPid: optionalNumber(row.owner_pid ?? null),
      ownerStarted: row.owner_started ?? null,
      childPid: optionalNumber(row.child_pid ?? null),
      childStarted: row.child_started ?? null,
      turnFiles: row.turn_files ? (JSON.parse(row.turn_files) as TurnFiles) : null,
      turnStartedAt: row.turn_started_at ?? null,
      deliveredRound: Number(row.delivered_round ?? 0),
    };
  }

  getRun(id: string): OrchestrationRun | undefined {
    const row = this.db
      .prepare("SELECT * FROM orchestration_runs WHERE id = ?")
      .get(id) as unknown as RunRow | undefined;
    return row ? this.toRun(row) : undefined;
  }

  updateRun(id: string, patch: RunPatch): OrchestrationRun {
    const current = this.getRun(id);
    if (!current) throw new Error(`Unknown orchestration run: ${id}`);
    const merged = { ...current, ...patch, updatedAt: this.now() };
    this.db
      .prepare(
        `UPDATE orchestration_runs
         SET status = ?, round = ?, codex_session_id = ?, latest_response = ?,
             worktree_path = ?, updated_at = ?, owner_pid = ?, owner_started = ?,
             child_pid = ?, child_started = ?, turn_files = ?, turn_started_at = ?
         WHERE id = ?`,
      )
      .run(
        merged.status,
        merged.round,
        merged.codexSessionId,
        merged.latestResponse === null ? null : JSON.stringify(merged.latestResponse),
        merged.worktreePath,
        merged.updatedAt,
        merged.ownerPid,
        merged.ownerStarted,
        merged.childPid,
        merged.childStarted,
        merged.turnFiles === null ? null : JSON.stringify(merged.turnFiles),
        merged.turnStartedAt,
        id,
      );
    return this.getRun(id) as OrchestrationRun;
  }

  runsWithStatus(status: OrchestrationStatus): OrchestrationRun[] {
    const rows = this.db
      .prepare("SELECT * FROM orchestration_runs WHERE status = ? ORDER BY created_at")
      .all(status) as unknown as RunRow[];
    return rows.map((row) => this.toRun(row));
  }

  /** Finished rounds whose result has not reached the coordinator yet. */
  undeliveredRuns(updatedBefore: string): OrchestrationRun[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM orchestration_runs
         WHERE owner_pid IS NOT NULL AND status != 'running_codex'
           AND delivered_round < round AND updated_at < ?
         ORDER BY updated_at`,
      )
      .all(updatedBefore) as unknown as RunRow[];
    return rows.map((row) => this.toRun(row));
  }

  /** Atomically take responsibility for handing one round's result over. */
  claimRunDelivery(id: string, round: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE orchestration_runs SET delivered_round = ?
         WHERE id = ? AND delivered_round < ? AND round = ? AND status != 'running_codex'`,
      )
      .run(round, id, round, round);
    return Number(result.changes) === 1;
  }

  /** Take over a running run whose owning process has exited. */
  adoptRun(id: string, previousOwner: number, ownerPid: number, ownerStarted: string | null): boolean {
    const result = this.db
      .prepare(
        `UPDATE orchestration_runs SET owner_pid = ?, owner_started = ?, updated_at = ?
         WHERE id = ? AND status = 'running_codex' AND owner_pid = ?`,
      )
      .run(ownerPid, ownerStarted, this.now(), id, previousOwner);
    return Number(result.changes) === 1;
  }

  appendRunEvent(runId: string, type: string, payload: Record<string, unknown>): RunEvent {
    const createdAt = this.now();
    const result = this.db
      .prepare(
        `INSERT INTO orchestration_events (run_id, event_type, payload, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(runId, type, JSON.stringify(payload), createdAt);
    return {
      id: Number(result.lastInsertRowid),
      runId,
      type,
      payload,
      createdAt,
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

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  /**
   * Cross-process "at most once per interval" claim. Returns true for exactly
   * one caller per interval, even when several bridge processes race.
   */
  claimInterval(key: string, intervalMs: number, now = Date.now()): boolean {
    const row = this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value
         WHERE CAST(meta.value AS INTEGER) <= ?
         RETURNING value`,
      )
      .get(key, String(now), now - intervalMs);
    return row !== undefined;
  }

  /** Background ping outcomes per app and state since a point in time. */
  wakeSummary(sinceMs: number): Array<{ app: string; state: string; count: number }> {
    const rows = this.db
      .prepare(
        `SELECT json_extract(target, '$.app') AS app, state, COUNT(*) AS n
         FROM wake_jobs WHERE created_at >= ? GROUP BY app, state ORDER BY app, n DESC`,
      )
      .all(sinceMs) as Array<{ app: string; state: string; n: number | bigint }>;
    return rows.map((row) => ({ app: row.app, state: row.state, count: Number(row.n) }));
  }

  runCounts(): Record<string, number> {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS n FROM orchestration_runs GROUP BY status")
      .all() as Array<{ status: string; n: number | bigint }>;
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.n)]));
  }

  quickCheck(): string {
    const row = this.db.prepare("PRAGMA quick_check").get() as { quick_check: string };
    return row.quick_check;
  }

  close(): void {
    this.db.close();
  }
}
