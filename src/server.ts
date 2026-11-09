#!/usr/bin/env node
import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { agentNameProblem, checkRecipient } from "./addressing.js";
import { BridgeStore } from "./bridge-store.js";
import { CHANNEL_CAPABILITY, channelSession } from "./claude-channel.js";
import { showInClaudeDesktop } from "./claude-desktop.js";
import { CLAUDE_EFFORTS, ClaudeCliRunner } from "./claude-runner.js";
import { claudeSessions } from "./claude-wake.js";
import { CodexAppServerRunner } from "./codex-app-runner.js";
import { Housekeeper } from "./housekeeping.js";
import { waitForInbox } from "./inbox-waiter.js";
import { retireAgent } from "./lifecycle.js";
import { BRIDGE_AGENT, CLAUDE_HOLD_EXPLANATION } from "./notices.js";
import { CodexCliRunner, DEFAULT_WAIT_MS, Orchestrator, type StartOrchestrationInput } from "./orchestrator.js";
import { DEFAULT_PAGE_CHARS, clampLimit, fitMessages, fitRows } from "./paging.js";
import { defaultDbPath, runsDir } from "./paths.js";
import { buildAskCodexTask, buildClaudeReadOnlyTask, buildCodexReviewTask } from "./simple-tools.js";
import { VERSION } from "./version.js";
import { WakeDispatcher } from "./wake-dispatcher.js";
import { RECENT_WAKE_JOBS, type WakeJob, type WakeTarget } from "./wake-queue.js";
import {
  CLAUDE_PERMISSION_MODES,
  EFFORT_LEVELS,
  WORKER_SANDBOX_MODES,
  checkWorkerRequest,
  loadPolicy,
  type WorkerKind,
} from "./worker-policy.js";

/** Everything the MCP protocol reads/writes must stay on stdout; logs go to stderr. */
function log(message: string): void {
  process.stderr.write(`[claude-codex-bridge] ${message}\n`);
}

function jsonResult(payload: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

/** Longest message preview in a ping receipt listing; the full body stays in the mailbox. */
const RECEIPT_PREVIEW_CHARS = 120;

/**
 * A ping receipt as bridge_wake_status lists it: the delivery facts, without
 * empty fields, internal attempt ids or the mailbox path repeated on every row.
 */
function wakeReceipt(job: WakeJob) {
  return {
    id: job.id,
    messageId: job.messageId,
    agent: job.agent,
    ...(job.fromAgent ? { fromAgent: job.fromAgent } : {}),
    ...(job.threadId ? { threadId: job.threadId } : {}),
    target: job.target,
    state: job.state,
    detail: job.detail,
    ...(job.pendingReason ? { pendingReason: job.pendingReason } : {}),
    attempts: job.attempts,
    createdAt: job.createdAt,
    ...(job.state === "pending" ? { retryAt: job.retryAt } : {}),
    ...(job.acknowledgedAt ? { acknowledgedAt: job.acknowledgedAt } : {}),
    ...(job.preview ? { preview: job.preview.slice(0, RECEIPT_PREVIEW_CHARS) } : {}),
  };
}

/** Claude session liveness. Unknown (non-macOS) counts as live so nothing is misreported. */
async function isClaudeSessionLive(sessionId: string): Promise<boolean> {
  if (process.platform !== "darwin") return true;
  const sessions = await claudeSessions();
  return sessions.some((session) => session.sessionId === sessionId || session.bridgeSessionId === sessionId);
}

/** The app session hosting this MCP process, when the host exposes it. */
function detectSession(env: NodeJS.ProcessEnv = process.env): WakeTarget | null {
  const claude = env.CLAUDE_CODE_SESSION_ID?.trim();
  if (claude) return { app: "claude", sessionId: claude };
  const codex = env.CODEX_THREAD_ID?.trim();
  if (codex) return { app: "codex", sessionId: codex };
  return null;
}

const INSTRUCTIONS = [
  "Local mailbox and Codex worker bridge shared by the Claude and Codex sessions on this machine.",
  "Mailbox: register a unique agent name once with bridge_register (wake: \"auto\" binds this conversation for background pings). Send with bridge_send; recipients must be registered and any delivery risk comes back as warnings. When pinged, read bridge_inbox, handle the work within the user's existing permissions, bridge_ack after handling, and reply to the sender only when complete, blocked or needing a decision. Never send acknowledgement-only replies. Messages from \"bridge\" are automated notices (delivery failures, retirements, Codex results); do not reply to them. bridge_outbox shows what recipients have not handled yet; bridge_retire closes out a finished task agent. Unbound agents may use bridge_wait during an active turn.",
  "Workers: ask_codex, review_with_codex and bridge_orchestrate_codex start a new Codex chat; ask_claude starts a new Claude Code chat. Both run in the background. Codex chats are sandboxed with network access off and appear in the Codex app's list. Claude chats run in the permission mode you choose (plan and manual read only; acceptEdits edits an isolated worktree) and can be opened in the Claude desktop app with showInDesktop. You may choose the model and reasoning effort; the owner's policy caps what may be chosen and how many chats may be started, and refuses anything above it. A call waits up to four minutes. If the worker is still going it returns running_codex, and the result arrives later in your mailbox from \"bridge\" (or call bridge_orchestration_wait). If the status is waiting_for_fable, answer the question and call bridge_continue_run with the same runId. Independent suggestedChips that the user's task needs may each get their own run (at most three). Verify reported work before calling it done.",
  "Nothing here authorizes commits, pushes, merges, deploys, external sends, credential changes, deletion or production changes.",
].join("\n\n");

// Bound both parser work and persisted input; output paging alone cannot do this.
const agentInput = z.string().min(1).max(128);
const threadInput = z.string().min(1).max(512);
const taskInput = z.string().min(1).max(200_000);

function main(): void {
  const dbPath = defaultDbPath();
  const store = new BridgeStore(dbPath);
  // Codex workers run through app-server so the Codex app lists their chats;
  // BRIDGE_CODEX_RUNNER=exec restores the earlier `codex exec` path.
  const codexRunner = process.env.BRIDGE_CODEX_RUNNER?.trim() === "exec" ? new CodexCliRunner() : new CodexAppServerRunner();
  const claudeRunner = new ClaudeCliRunner();
  const orchestrator = new Orchestrator(store, codexRunner, undefined, {
    claudeRunner,
    showInDesktop: ({ cwd, sessionId }) => showInClaudeDesktop({ binary: claudeRunner.binary, cwd, sessionId }),
  });
  const channelSessionId = channelSession();
  const localAgents: string[] = [];
  const defaultAgent = () => localAgents.at(-1) ?? "claude-main";
  const projectFallback = () => {
    const project = process.env.CLAUDE_PROJECT_DIR?.trim();
    if (!project) throw new Error("projectPath is required: this session did not report a project directory.");
    return project;
  };

  log(`store ready at ${dbPath} (schema v${store.migration.to})`);
  if (store.migration.from < store.migration.to) {
    log(`migrated mailbox schema v${store.migration.from} to v${store.migration.to}; backup in ${store.backupDir}`);
  }
  if (store.migration.newer) log("mailbox schema is newer than this bridge build; running in compatible mode");

  const server = new McpServer(
    { name: "claude-codex-bridge", version: VERSION },
    {
      ...(channelSessionId ? { capabilities: { experimental: { [CHANNEL_CAPABILITY]: {} } } } : {}),
      instructions: INSTRUCTIONS,
      maxToolInputElements: 10_000,
    },
  );

  const dispatcher = new WakeDispatcher(store, {
    channel: channelSessionId
      ? {
          sessionId: channelSessionId,
          send: (notification) =>
            server.server.notification(notification as unknown as Parameters<typeof server.server.notification>[0]),
        }
      : null,
  });
  const housekeeper = new Housekeeper(store, orchestrator, { runsDir: runsDir(), log });

  // A waiting call can outlive its caller: the user stops the turn, the host
  // times the call out, or the host process disappears. Waits watch for all
  // three, so nothing is acknowledged or claimed for a caller that has gone.
  const closing = new AbortController();
  const callerGone = (extra: { signal: AbortSignal }) => AbortSignal.any([extra.signal, closing.signal]);

  const pagingInput = {
    limit: z.number().int().min(1).max(200).optional().describe("Maximum messages to return. Defaults to 25 (30 for threads)."),
    maxChars: z.number().int().min(1000).max(400000).optional().describe("Character budget for the whole result. Defaults to 48000 so MCP hosts never truncate it."),
    maxBodyChars: z.number().int().min(0).max(400000).optional().describe("Preview mode: shorten every body to this many characters."),
  };

  server.registerTool(
    "bridge_register",
    {
      title: "Register agent presence",
      description:
        "Register a unique agent name for this conversation. wake: \"auto\" binds this exact app session for background pings; an explicit {app, sessionId} binds another session; null disables pings; omitted keeps the current binding. Registering again reactivates a retired agent.",
      inputSchema: {
        agent: agentInput.describe("Unique readable agent name, e.g. 'review-claude'. Not a session ID."),
        wake: z
          .union([
            z.literal("auto"),
            z.object({ app: z.enum(["codex", "claude"]), sessionId: z.string().min(1).max(128) }),
          ])
          .nullable()
          .optional()
          .describe("\"auto\" detects this conversation's session. Or pass {app, sessionId} (Claude IDs via bridge_sessions; the Codex task ID). null disables pings."),
        capabilities: z
          .array(z.string().max(128))
          .max(64)
          .optional()
          .describe("Skills this agent offers, e.g. ['review','architecture']. Omitted keeps the existing list."),
      },
    },
    async ({ agent, capabilities, wake }) => {
      const problem = agentNameProblem(agent);
      if (problem) throw new Error(problem);
      const notes: string[] = [];
      if (wake !== undefined) {
        const target = wake === "auto" ? detectSession() : wake;
        if (wake === "auto" && !target) {
          throw new Error("Could not detect this conversation's session. For Codex, pass wake: {app: \"codex\", sessionId: \"<task ID>\"}.");
        }
        const current = store.wakes.target(agent);
        if (target && current && (current.app !== target.app || current.sessionId !== target.sessionId)) {
          const stale = current.app === "claude" && !(await isClaudeSessionLive(current.sessionId));
          if (!stale) {
            throw new Error(`"${agent}" is bound to a different live ${current.app} session. Choose a unique agent name, or unbind it with wake: null first.`);
          }
          store.wakes.bind(agent, null);
          notes.push("The previous Claude session is no longer running, so the binding moved to this session.");
        }
        store.wakes.bind(agent, target);
      }
      const registered = store.register(agent, capabilities);
      localAgents.splice(0, localAgents.length, ...localAgents.filter((name) => name !== agent), agent);
      const unread = store.countUnread(agent);
      return jsonResult({
        ...registered,
        wake: store.wakes.target(agent),
        unread,
        ...(unread > 0 ? { next: `${unread} unread message(s) are waiting. Read them with bridge_inbox.` } : {}),
        ...(notes.length ? { notes } : {}),
      });
    },
  );

  server.registerTool(
    "bridge_send",
    {
      title: "Send a message",
      description:
        "Save a message, then ping its bound recipient in the background. The recipient must be registered (use allowUnregistered only when it will register later). The result carries warnings when the recipient is unlikely to pick the message up. Broadcasts and wake:false sends do not ping anyone.",
      inputSchema: {
        wake: z.boolean().optional().describe("Ping a bound direct recipient. Defaults true. False saves silently."),
        from: agentInput.describe("Sender agent name."),
        to: agentInput.describe("Recipient agent name, or '*' to broadcast."),
        body: z.string().min(1).max(1_000_000).describe("Message content."),
        threadId: threadInput.optional().describe("Optional conversation thread identifier."),
        idempotencyKey: z.string().max(256).optional().describe("Optional key to prevent duplicate delivery on retry."),
        allowUnregistered: z.boolean().optional().describe("Deliver even if the recipient is unknown or retired."),
      },
    },
    async ({ from, to, body, threadId, idempotencyKey, wake, allowUnregistered }) => {
      if (from === BRIDGE_AGENT) throw new Error(`"${BRIDGE_AGENT}" is reserved for automated notices.`);
      const check = await checkRecipient(store, to, { allowUnregistered, isClaudeSessionLive });
      if (!check.ok) throw new Error(check.error);
      const warnings = [...check.warnings];
      if (!store.getAgent(from)) {
        warnings.push(`Sender "${from}" is not registered, so replies and delivery notices may not reach it. Call bridge_register first.`);
      }
      const message = store.send({
        wake,
        fromAgent: from,
        toAgent: to,
        body,
        threadId: threadId ?? null,
        idempotencyKey: idempotencyKey ?? null,
      });
      store.touch(from);
      await dispatcher.flush();
      return jsonResult({
        ...message,
        wake: store.wakes.forMessage(message.id),
        ...(warnings.length ? { warnings } : {}),
      });
    },
  );

  server.registerTool("bridge_sessions", {
    title: "Discover local wake targets",
    description: "Read live Claude session IDs and this conversation's own session when the host exposes it. Does not wake anything or read conversation content.",
    inputSchema: {},
  }, async () => jsonResult({
    mailboxPath: dbPath,
    thisSession: detectSession(),
    claude: await claudeSessions(),
    codexSessionId: process.env.CODEX_THREAD_ID ?? null,
    channelMode: channelSessionId ? "enabled" : "off",
    note: "bridge_register with wake: \"auto\" uses thisSession. Codex does not expose its task ID to MCP servers in every version; pass it explicitly when thisSession is null. Background adapters are experimental macOS local interfaces.",
  }));

  server.registerTool("bridge_wake_status", {
    title: "Inspect background ping delivery",
    description: "Read recent ping receipts, newest first, with a per-state summary of the latest 100. Returns 20 receipts by default in a page that fits the host's output limit; pass beforeId (olderBeforeId) for older ones. Accepted means the app accepted a ping, not that the work is complete. Held/refused respect app permission checks; unknown outcomes are never replayed automatically.",
    inputSchema: {
      agent: agentInput.optional().describe("Only pings to this recipient."),
      limit: z.number().int().min(1).max(RECENT_WAKE_JOBS).optional().describe("Maximum receipts to return. Defaults to 20."),
      beforeId: z.number().int().min(1).optional().describe("Return receipts older than this receipt id (paging cursor)."),
    },
  }, async ({ agent, limit, beforeId }) => {
    const max = limit ?? 20;
    const recent = store.wakes.recentStates(agent);
    const listed = store.wakes.list(agent, { limit: max + 1, beforeId });
    // Room for the summary and, when Claude holds pings, the explanation.
    const fitted = fitRows(listed.slice(0, max).map(wakeReceipt), DEFAULT_PAGE_CHARS, 2_000);
    const hasMore = listed.length > max || fitted.omitted > 0;
    return jsonResult({
      mailboxPath: dbPath,
      summary: recent.byState,
      summaryOf: recent.jobs,
      ...(recent.claudeHold ? { explanation: CLAUDE_HOLD_EXPLANATION } : {}),
      count: fitted.rows.length,
      hasMore,
      olderBeforeId: hasMore ? fitted.rows.at(-1)?.id ?? null : null,
      jobs: fitted.rows,
    });
  });

  server.registerTool(
    "bridge_inbox",
    {
      title: "Read inbox",
      description:
        "List messages addressed to an agent, oldest first, in pages that fit the host's output limit. Acknowledged messages are hidden by default. When hasMore is true, acknowledge handled messages and read again, or pass afterId.",
      inputSchema: {
        agent: agentInput.describe("Agent whose inbox to read."),
        includeAcknowledged: z.boolean().optional().describe("Include messages this agent has already acknowledged."),
        fromAgent: agentInput.optional().describe("Only messages from this sender."),
        threadId: threadInput.optional().describe("Only messages on this thread."),
        afterId: z.number().int().min(0).optional().describe("Only messages with a larger id (paging cursor)."),
        ...pagingInput,
      },
    },
    async ({ agent, includeAcknowledged, fromAgent, threadId, afterId, limit, maxChars, maxBodyChars }) => {
      const page = store.inboxPage(agent, { includeAcknowledged, fromAgent, threadId, afterId, limit, maxChars, maxBodyChars });
      store.wakes.recordRead(agent, page.messages.map((message) => message.id));
      store.touch(agent);
      return jsonResult({ agent, ...page });
    },
  );

  server.registerTool(
    "bridge_wait",
    {
      title: "Wait for the next bridge message",
      description:
        "Keep this agent turn alive until a matching bridge message arrives, for agents without background pings. It cannot wake a chat whose turn has already ended, so call it before going idle. After handling and replying, call bridge_wait again while the coordination thread is active.",
      inputSchema: {
        agent: agentInput.describe("Agent whose inbox should wake this turn."),
        fromAgent: agentInput.optional().describe("Optional sender filter."),
        threadId: threadInput.optional().describe("Optional coordination thread filter."),
        timeoutSeconds: z.number().int().min(1).max(290).optional().describe("How long to keep the MCP call open. Defaults to 285 seconds so common five-minute host limits do not cut it off."),
        acknowledge: z.boolean().optional().describe("Mark returned messages handled before returning. Defaults true; history is preserved."),
        limit: pagingInput.limit,
        maxChars: pagingInput.maxChars,
      },
    },
    async ({ agent, fromAgent, threadId, timeoutSeconds, acknowledge, limit, maxChars }, extra) => {
      const max = clampLimit(limit);
      const signal = callerGone(extra);
      store.touch(agent);
      const result = await waitForInbox(store, {
        agent,
        fromAgent,
        threadId,
        timeoutMs: (timeoutSeconds ?? 285) * 1000,
        limit: max + 1,
        signal,
      });
      if (result.aborted || signal.aborted) {
        // Nobody receives this result, so the messages stay unread for the next reader.
        return jsonResult({
          timedOut: false,
          cancelled: true,
          count: 0,
          acknowledged: 0,
          hasMore: false,
          messages: [],
          nextAction: "This wait was cancelled before anything was returned or acknowledged. Read bridge_inbox, or call bridge_wait again.",
        });
      }
      const fitted = fitMessages(result.messages.slice(0, max), { maxChars });
      const ids = fitted.messages.map((message) => message.id);
      const acknowledged = (acknowledge ?? true) && ids.length > 0 ? store.ack(agent, ids) : 0;
      store.wakes.recordRead(agent, ids);
      return jsonResult({
        timedOut: result.timedOut,
        count: fitted.messages.length,
        acknowledged,
        hasMore: result.messages.length > max || fitted.omitted > 0,
        messages: fitted.messages,
        nextAction: result.timedOut
          ? "If the coordination thread is still active, call bridge_wait again."
          : "Handle these messages, reply with bridge_send, then call bridge_wait again before ending the turn.",
      });
    },
  );

  server.registerTool(
    "bridge_ack",
    {
      title: "Acknowledge messages",
      description: "Mark messages as handled for an agent so they drop out of the unread inbox. History is kept.",
      inputSchema: {
        agent: agentInput.describe("Agent acknowledging the messages."),
        ids: z.array(z.number().int().positive()).min(1).max(1000).describe("Message ids to acknowledge."),
      },
    },
    async ({ agent, ids }) => {
      const acknowledged = store.ack(agent, ids);
      store.touch(agent);
      return jsonResult({ acknowledged, remainingUnread: store.countUnread(agent) });
    },
  );

  server.registerTool(
    "bridge_thread",
    {
      title: "Read a thread",
      description:
        "Read one page of a conversation thread. Without a cursor it returns the most recent messages; pass beforeId (olderBeforeId) to page back or afterId (newerAfterId) to page forward.",
      inputSchema: {
        threadId: threadInput.describe("Thread identifier to fetch."),
        beforeId: z.number().int().min(1).optional().describe("Return messages older than this id."),
        afterId: z.number().int().min(0).optional().describe("Return messages newer than this id."),
        ...pagingInput,
      },
    },
    async ({ threadId, beforeId, afterId, limit, maxChars, maxBodyChars }) =>
      jsonResult(store.threadPage(threadId, { beforeId, afterId, limit, maxChars, maxBodyChars })),
  );

  server.registerTool(
    "bridge_agents",
    {
      title: "List agents",
      description: "List registered agents, most recently active first, with unread counts, last activity, ping binding and recent ping health. Returns 50 by default in a page that fits the host's output limit: total says how many matched, and nextOffset continues the list. Use query to find agents by name or capability. Retired agents are hidden unless requested.",
      inputSchema: {
        includeRetired: z.boolean().optional().describe("Include retired agents."),
        query: z.string().min(1).max(128).optional().describe("Only agents whose name or capabilities contain this text (case-insensitive)."),
        limit: z.number().int().min(1).max(200).optional().describe("Maximum agents to return. Defaults to 50."),
        offset: z.number().int().min(0).optional().describe("Skip this many agents (paging cursor; pass nextOffset)."),
      },
    },
    async ({ includeRetired, query, limit, offset }) => {
      const start = offset ?? 0;
      const page = store.agentPage({ includeRetired, query, limit, offset: start });
      const rows = page.agents.map((agent) => {
        const health = store.wakes.health(agent.name, 1)[0];
        return {
          name: agent.name,
          ...(agent.capabilities.length ? { capabilities: agent.capabilities } : {}),
          registeredAt: agent.registeredAt,
          lastSeen: agent.lastSeen,
          lastActivity: agent.lastActivity,
          unread: agent.unread,
          wake: store.wakes.target(agent.name),
          ...(health ? { lastPing: { state: health.state, detail: health.detail } } : {}),
          ...(agent.retiredAt ? { retiredAt: agent.retiredAt, retiredBy: agent.retiredBy, retireNote: agent.retireNote } : {}),
        };
      });
      const fitted = fitRows(rows, DEFAULT_PAGE_CHARS, 1_000);
      const next = start + fitted.rows.length;
      const hasMore = next < page.total;
      return jsonResult({
        count: fitted.rows.length,
        total: page.total,
        hasMore,
        nextOffset: hasMore ? next : null,
        agents: fitted.rows,
      });
    },
  );

  server.registerTool(
    "bridge_outbox",
    {
      title: "Check sent messages",
      description: "List direct messages an agent sent that the recipient has not acknowledged yet (newest first), with ping outcome and whether the recipient is active, retired or unknown.",
      inputSchema: {
        agent: agentInput.describe("Sender whose outbox to read."),
        includeAcknowledged: z.boolean().optional().describe("Include messages the recipient already acknowledged."),
        limit: z.number().int().min(1).max(200).optional().describe("Maximum entries. Defaults to 30."),
      },
    },
    async ({ agent, includeAcknowledged, limit }) => {
      store.touch(agent);
      return jsonResult({ agent, ...store.outbox(agent, { includeAcknowledged, limit }) });
    },
  );

  server.registerTool(
    "bridge_retire",
    {
      title: "Retire a finished agent",
      description:
        "Retire an agent whose task is over: its pings stop, its unhandled messages are closed with a recorded reason (history is kept), and recently active senders get one notice listing what was closed. Registering the name again reactivates it.",
      inputSchema: {
        agent: agentInput.describe("Agent to retire."),
        by: agentInput.optional().describe("Who is retiring it. Defaults to this conversation's agent."),
        note: z.string().max(500).optional().describe("Short reason, e.g. 'task merged'."),
        closeBacklog: z.boolean().optional().describe("Close unhandled messages. Defaults true."),
        notifySenders: z.boolean().optional().describe("Tell recently active senders what was closed. Defaults true."),
      },
    },
    async ({ agent, by, note, closeBacklog, notifySenders }) =>
      jsonResult(retireAgent(store, agent, { by: by ?? localAgents.at(-1) ?? "operator", note, closeBacklog, notifySenders })),
  );

  const waitSeconds = z
    .number()
    .int()
    .min(0)
    .max(285)
    .optional()
    .describe("How long this call waits for the worker. Defaults to 240 seconds. If it is still working, the result arrives in the coordinator's mailbox.");
  const waitMs = (seconds: number | undefined) => (seconds === undefined ? DEFAULT_WAIT_MS : seconds * 1000);
  const projectInput = z.string().min(1).max(4096).optional();
  const coordinatorInput = agentInput.optional().describe("Agent that receives the result. Defaults to this conversation's registered agent, else claude-main.");
  const modelInput = z.string().min(1).max(120).optional();
  const CEILING = "The owner's policy.json sets what may be chosen; a request above it is refused with the limit named.";

  /** A recognisable name for the chat in the app's own list, from the first line of the request. */
  const chatTitle = (text: string) => {
    const line = text.split("\n").map((part) => part.trim()).find(Boolean) ?? "worker chat";
    return `Bridge: ${line.replace(/\s+/g, " ").slice(0, 60)}`;
  };

  /** Check a request against the owner's ceiling, then start the worker chat. */
  const startWorker = (
    request: Omit<StartOrchestrationInput, "warnings" | "showInDesktop"> & { worker: WorkerKind; showInDesktop?: boolean },
  ) => {
    const { policy, source } = loadPolicy();
    const decision = checkWorkerRequest(
      policy,
      {
        worker: request.worker,
        projectPath: request.projectPath,
        model: request.model,
        effort: request.effort,
        sandbox: request.worker === "codex" ? request.sandbox : undefined,
        permissionMode: request.permissionMode,
        showInDesktop: request.showInDesktop,
        startsLastHour: store.countRunsSince(new Date(Date.now() - 3_600_000).toISOString()),
      },
      source,
    );
    return orchestrator.start({ ...request, showInDesktop: decision.showInDesktop, warnings: decision.warnings });
  };

  server.registerTool(
    "ask_codex",
    {
      title: "Ask Codex",
      description:
        `Send one bounded implementation, investigation, or verification task to a new Codex worker chat in an isolated worktree. This is the simple everyday entry point; no mailbox or thread management is required. The chat appears in the Codex app's list (appLink opens it) but runs in the background, sandboxed with network access off. Optionally choose the model, reasoning effort and sandbox. ${CEILING}`,
      inputSchema: {
        projectPath: projectInput.describe("Absolute path to the repository. Defaults to this session's project directory."),
        request: taskInput.describe("What Codex should do."),
        coordinatorAgent: coordinatorInput,
        threadId: threadInput.optional().describe("Optional stable task ID. Generated when omitted."),
        useWorktree: z.boolean().optional().describe("Use an isolated Git worktree. Defaults true."),
        includeUncommitted: z.boolean().optional().describe("Copy the main checkout's uncommitted changes into the worktree."),
        model: modelInput.describe("Codex model for this chat. Defaults to Codex's own default."),
        reasoningEffort: z.enum(EFFORT_LEVELS).optional().describe("Reasoning effort. Defaults to the model's own default."),
        sandbox: z.enum(WORKER_SANDBOX_MODES).optional().describe("read-only cannot change files; workspace-write (the default) can change files in the workspace."),
        waitSeconds,
      },
    },
    async ({ projectPath, request, coordinatorAgent, threadId, useWorktree, includeUncommitted, model, reasoningEffort, sandbox, waitSeconds: seconds }, extra) =>
      jsonResult(
        await startWorker({
          worker: "codex",
          coordinatorAgent: coordinatorAgent ?? defaultAgent(),
          projectPath: projectPath ?? projectFallback(),
          task: buildAskCodexTask(request),
          threadId: threadId ?? `ask-codex-${randomUUID()}`,
          useWorktree: useWorktree ?? true,
          includeUncommitted,
          maxRounds: 4,
          model,
          effort: reasoningEffort,
          sandbox,
          title: chatTitle(request),
          waitMs: waitMs(seconds),
          signal: callerGone(extra),
        }),
      ),
  );

  server.registerTool(
    "review_with_codex",
    {
      title: "Review with Codex",
      description:
        `Ask Codex for a read-only repository review with evidence and actionable findings. Codex runs in a read-only sandbox and the bridge reports whether the workspace changed. Optionally choose the model and reasoning effort. ${CEILING}`,
      inputSchema: {
        projectPath: projectInput.describe("Absolute path to the repository. Defaults to this session's project directory."),
        focus: z.string().max(200_000).optional().describe("Optional review focus, such as security, a PR, or a subsystem."),
        coordinatorAgent: coordinatorInput,
        threadId: threadInput.optional().describe("Optional stable task ID. Generated when omitted."),
        model: modelInput.describe("Codex model for this chat. Defaults to Codex's own default."),
        reasoningEffort: z.enum(EFFORT_LEVELS).optional().describe("Reasoning effort. Defaults to the model's own default."),
        waitSeconds,
      },
    },
    async ({ projectPath, focus, coordinatorAgent, threadId, model, reasoningEffort, waitSeconds: seconds }, extra) =>
      jsonResult(
        await startWorker({
          worker: "codex",
          coordinatorAgent: coordinatorAgent ?? defaultAgent(),
          projectPath: projectPath ?? projectFallback(),
          task: buildCodexReviewTask(focus),
          threadId: threadId ?? `codex-review-${randomUUID()}`,
          useWorktree: false,
          sandbox: "read-only",
          maxRounds: 1,
          model,
          effort: reasoningEffort,
          title: chatTitle(focus?.trim() ? `Review: ${focus}` : "Repository review"),
          waitMs: waitMs(seconds),
          signal: callerGone(extra),
        }),
      ),
  );

  server.registerTool(
    "bridge_orchestrate_codex",
    {
      title: "Start an autonomous Codex implementation run",
      description:
        `Start a Codex worker chat in an isolated git worktree (network off) and wait up to waitSeconds for its structured result. If status is waiting_for_fable, answer the question and call bridge_continue_run. If it is running_codex, the result arrives in the coordinator's mailbox. Independent calls create separate runs. Optionally choose the model, reasoning effort and sandbox. ${CEILING} This tool never grants permission to commit, push, deploy, publish, send externally, change credentials, delete data, or mutate production.`,
      inputSchema: {
        coordinatorAgent: coordinatorInput,
        projectPath: projectInput.describe("Absolute path to the git repository. Defaults to this session's project directory."),
        task: taskInput.describe("Self-contained implementation or verification task."),
        threadId: threadInput.describe("Stable task/thread identifier."),
        useWorktree: z.boolean().optional().describe("Create an isolated git worktree. Defaults true."),
        includeUncommitted: z.boolean().optional().describe("Copy the main checkout's uncommitted changes into the worktree."),
        maxRounds: z.number().int().min(1).max(12).optional().describe("Maximum coordinator/Codex turns. Defaults 6."),
        model: modelInput.describe("Codex model for this chat. Defaults to Codex's own default."),
        reasoningEffort: z.enum(EFFORT_LEVELS).optional().describe("Reasoning effort. Defaults to the model's own default."),
        sandbox: z.enum(WORKER_SANDBOX_MODES).optional().describe("read-only cannot change files; workspace-write (the default) can change files in the workspace."),
        waitSeconds,
      },
    },
    async ({ coordinatorAgent, projectPath, task, threadId, useWorktree, includeUncommitted, maxRounds, model, reasoningEffort, sandbox, waitSeconds: seconds }, extra) =>
      jsonResult(
        await startWorker({
          worker: "codex",
          coordinatorAgent: coordinatorAgent ?? defaultAgent(),
          projectPath: projectPath ?? projectFallback(),
          task,
          threadId,
          useWorktree: useWorktree ?? true,
          includeUncommitted,
          maxRounds: maxRounds ?? 6,
          model,
          effort: reasoningEffort,
          sandbox,
          title: chatTitle(task),
          waitMs: waitMs(seconds),
          signal: callerGone(extra),
        }),
      ),
  );

  server.registerTool(
    "ask_claude",
    {
      title: "Ask Claude",
      description:
        `Send one bounded task to a new Claude Code worker chat that runs in the background. Choose the model, reasoning effort and permission mode: plan and manual cannot change files and read the real checkout; acceptEdits (the default) edits files in an isolated git worktree; auto decides for itself. showInDesktop opens the finished chat in the Claude desktop app, which switches to it. ${CEILING} Workers run without MCP servers and need the Claude Code CLI signed in (claude auth login). If status is waiting_for_fable, answer the question and call bridge_continue_run. Nothing here grants permission to commit, push, deploy, publish, send externally, change credentials, delete data, or mutate production.`,
      inputSchema: {
        projectPath: projectInput.describe("Absolute path to the repository. Defaults to this session's project directory."),
        request: taskInput.describe("What Claude should do."),
        coordinatorAgent: coordinatorInput,
        threadId: threadInput.optional().describe("Optional stable task ID. Generated when omitted."),
        model: modelInput.describe("Claude model or alias, e.g. 'haiku', 'sonnet', 'opus'. Defaults to Claude Code's own default."),
        effort: z.enum(CLAUDE_EFFORTS).optional().describe("Reasoning effort. Defaults to the model's own default."),
        permissionMode: z.enum(CLAUDE_PERMISSION_MODES).optional().describe("plan or manual: read only. acceptEdits (default): may edit files in the workspace. auto: decides for itself."),
        useWorktree: z.boolean().optional().describe("Use an isolated Git worktree. Defaults true for acceptEdits and auto, false for plan and manual."),
        includeUncommitted: z.boolean().optional().describe("Copy the main checkout's uncommitted changes into the worktree."),
        showInDesktop: z.boolean().optional().describe("Open the finished chat in the Claude desktop app. The app switches to it, so ask only when the user wants to see it."),
        waitSeconds,
      },
    },
    async ({ projectPath, request, coordinatorAgent, threadId, model, effort, permissionMode, useWorktree, includeUncommitted, showInDesktop, waitSeconds: seconds }, extra) => {
      const mode = permissionMode ?? "acceptEdits";
      const readOnly = mode === "plan" || mode === "manual";
      return jsonResult(
        await startWorker({
          worker: "claude",
          coordinatorAgent: coordinatorAgent ?? defaultAgent(),
          projectPath: projectPath ?? projectFallback(),
          task: readOnly ? buildClaudeReadOnlyTask(request) : buildAskCodexTask(request),
          threadId: threadId ?? `ask-claude-${randomUUID()}`,
          useWorktree: useWorktree ?? !readOnly,
          includeUncommitted,
          maxRounds: 4,
          model,
          effort,
          permissionMode: mode,
          showInDesktop,
          title: chatTitle(request),
          waitMs: waitMs(seconds),
          signal: callerGone(extra),
        }),
      );
    },
  );

  server.registerTool(
    "bridge_continue_run",
    {
      title: "Continue a worker with the coordinator's answer",
      description:
        "Resume the exact saved worker chat (Codex or Claude) and workspace after the worker asked for a decision (status waiting_for_fable). The model, sandbox or permission mode from the first turn are kept. Continue until completed, blocked, failed, or the round limit is reached.",
      inputSchema: {
        runId: z.string().uuid().describe("Run ID returned by the tool that started the worker."),
        answer: taskInput.describe("The coordinator's concrete answer to the worker's question."),
        waitSeconds,
      },
    },
    async ({ runId, answer, waitSeconds: seconds }, extra) =>
      jsonResult(await orchestrator.continueWithFable(runId, answer, waitMs(seconds), callerGone(extra))),
  );

  server.registerTool(
    "bridge_continue_codex",
    {
      title: "Continue Codex with the coordinator's answer",
      description:
        "Earlier name of bridge_continue_run, kept for existing callers: resume the exact saved worker chat and workspace after it asked for a decision (status waiting_for_fable). The sandbox from the first turn is kept.",
      inputSchema: {
        runId: z.string().uuid().describe("Run ID returned by the orchestration tool."),
        fableAnswer: taskInput.describe("The coordinator's concrete answer to the worker's question."),
        waitSeconds,
      },
    },
    async ({ runId, fableAnswer, waitSeconds: seconds }, extra) =>
      jsonResult(await orchestrator.continueWithFable(runId, fableAnswer, waitMs(seconds), callerGone(extra))),
  );

  server.registerTool(
    "bridge_orchestration_wait",
    {
      title: "Wait for a worker run",
      description: "Wait up to timeoutSeconds for a running Codex or Claude worker run to finish its current round, then return its result. Works for runs started by any bridge process.",
      inputSchema: {
        runId: z.string().uuid().describe("Orchestration run ID."),
        timeoutSeconds: z.number().int().min(0).max(285).optional().describe("Defaults to 240 seconds."),
      },
    },
    async ({ runId, timeoutSeconds }, extra) =>
      jsonResult(await orchestrator.wait(runId, waitMs(timeoutSeconds), callerGone(extra))),
  );

  server.registerTool(
    "bridge_orchestration_status",
    {
      title: "Inspect an orchestration run",
      description: "Recover durable run state and its audit events after a restart or when checking progress.",
      inputSchema: {
        runId: z.string().uuid().describe("Orchestration run ID."),
      },
    },
    async ({ runId }) => jsonResult(orchestrator.status(runId)),
  );

  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    closing.abort();
    log(`received ${signal}, shutting down`);
    housekeeper.stop();
    orchestrator.close();
    void dispatcher.close().then(() => server.close()).finally(() => {
      store.close();
      process.exit(0);
    });
  };
  server.server.onclose = () => shutdown("transport closed");
  // The SDK's stdio transport does not watch for end of input. A host that
  // crashes or is force-quit closes the pipe without sending a signal.
  process.stdin.once("end", () => shutdown("end of input"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  server
    .connect(transport)
    .then(() => {
      dispatcher.start();
      housekeeper.start();
      log(`connected over stdio (v${VERSION}${channelSessionId ? ", Claude channel mode" : ""})`);
    })
    .catch((error: unknown) => {
      log(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      housekeeper.stop();
      void dispatcher.close().finally(() => { store.close(); process.exit(1); });
    });
}

main();
