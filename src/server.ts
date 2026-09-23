#!/usr/bin/env node
import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { agentNameProblem, checkRecipient } from "./addressing.js";
import { BridgeStore } from "./bridge-store.js";
import { CHANNEL_CAPABILITY, channelSession } from "./claude-channel.js";
import { claudeSessions } from "./claude-wake.js";
import { Housekeeper } from "./housekeeping.js";
import { waitForInbox } from "./inbox-waiter.js";
import { retireAgent } from "./lifecycle.js";
import { BRIDGE_AGENT, CLAUDE_HOLD_EXPLANATION } from "./notices.js";
import { DEFAULT_WAIT_MS, Orchestrator } from "./orchestrator.js";
import { clampLimit, fitMessages } from "./paging.js";
import { defaultDbPath, runsDir } from "./paths.js";
import { buildAskCodexTask, buildCodexReviewTask } from "./simple-tools.js";
import { VERSION } from "./version.js";
import { WakeDispatcher } from "./wake-dispatcher.js";
import type { WakeTarget } from "./wake-queue.js";

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
  "Codex workers: ask_codex, review_with_codex and bridge_orchestrate_codex start a saved Codex session. Reviews run read-only; implementation runs in an isolated worktree with network access off. A call waits up to four minutes. If Codex is still working it returns running_codex, and the result arrives later in your mailbox from \"bridge\" (or call bridge_orchestration_wait). If the status is waiting_for_fable, answer the question and call bridge_continue_codex with the same runId. Independent suggestedChips that the user's task needs may each get their own run (at most three). Verify reported work before calling it done.",
  "Nothing here authorizes commits, pushes, merges, deploys, external sends, credential changes, deletion or production changes.",
].join("\n\n");

function main(): void {
  const dbPath = defaultDbPath();
  const store = new BridgeStore(dbPath);
  const orchestrator = new Orchestrator(store);
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
        agent: z.string().min(1).describe("Unique readable agent name, e.g. 'review-claude'. Not a session ID."),
        wake: z
          .union([
            z.literal("auto"),
            z.object({ app: z.enum(["codex", "claude"]), sessionId: z.string().min(1).max(128) }),
          ])
          .nullable()
          .optional()
          .describe("\"auto\" detects this conversation's session. Or pass {app, sessionId} (Claude IDs via bridge_sessions; the Codex task ID). null disables pings."),
        capabilities: z
          .array(z.string())
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
        from: z.string().min(1).describe("Sender agent name."),
        to: z.string().min(1).describe("Recipient agent name, or '*' to broadcast."),
        body: z.string().min(1).describe("Message content."),
        threadId: z.string().optional().describe("Optional conversation thread identifier."),
        idempotencyKey: z.string().optional().describe("Optional key to prevent duplicate delivery on retry."),
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
    description: "Read up to 100 recent wake receipts with a per-state summary. Accepted means the app accepted a ping, not that the work is complete. Held/refused respect app permission checks; unknown outcomes are never replayed automatically.",
    inputSchema: { agent: z.string().min(1).optional() },
  }, async ({ agent }) => {
    const jobs = store.wakes.list(agent);
    const summary: Record<string, number> = {};
    for (const job of jobs) summary[job.state] = (summary[job.state] ?? 0) + 1;
    const claudeHolds = jobs.some((job) => job.target.app === "claude" && (job.state === "held" || /expired|held/i.test(job.detail)));
    return jsonResult({ summary, ...(claudeHolds ? { explanation: CLAUDE_HOLD_EXPLANATION } : {}), jobs });
  });

  server.registerTool(
    "bridge_inbox",
    {
      title: "Read inbox",
      description:
        "List messages addressed to an agent, oldest first, in pages that fit the host's output limit. Acknowledged messages are hidden by default. When hasMore is true, acknowledge handled messages and read again, or pass afterId.",
      inputSchema: {
        agent: z.string().min(1).describe("Agent whose inbox to read."),
        includeAcknowledged: z.boolean().optional().describe("Include messages this agent has already acknowledged."),
        fromAgent: z.string().min(1).optional().describe("Only messages from this sender."),
        threadId: z.string().min(1).optional().describe("Only messages on this thread."),
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
        agent: z.string().min(1).describe("Agent whose inbox should wake this turn."),
        fromAgent: z.string().min(1).optional().describe("Optional sender filter."),
        threadId: z.string().min(1).optional().describe("Optional coordination thread filter."),
        timeoutSeconds: z.number().int().min(1).max(290).optional().describe("How long to keep the MCP call open. Defaults to 285 seconds so common five-minute host limits do not cut it off."),
        acknowledge: z.boolean().optional().describe("Mark returned messages handled before returning. Defaults true; history is preserved."),
        limit: pagingInput.limit,
        maxChars: pagingInput.maxChars,
      },
    },
    async ({ agent, fromAgent, threadId, timeoutSeconds, acknowledge, limit, maxChars }) => {
      const max = clampLimit(limit);
      store.touch(agent);
      const result = await waitForInbox(store, {
        agent,
        fromAgent,
        threadId,
        timeoutMs: (timeoutSeconds ?? 285) * 1000,
        limit: max + 1,
      });
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
        agent: z.string().min(1).describe("Agent acknowledging the messages."),
        ids: z.array(z.number().int().positive()).min(1).describe("Message ids to acknowledge."),
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
        threadId: z.string().min(1).describe("Thread identifier to fetch."),
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
      description: "List registered agents with unread counts, last activity, ping binding and recent ping health. Retired agents are hidden unless requested.",
      inputSchema: {
        includeRetired: z.boolean().optional().describe("Include retired agents."),
      },
    },
    async ({ includeRetired }) => {
      const agents = store.agentSummaries({ includeRetired }).map((agent) => {
        const health = store.wakes.health(agent.name, 1)[0];
        return {
          ...agent,
          wake: store.wakes.target(agent.name),
          ...(health ? { lastPing: { state: health.state, detail: health.detail } } : {}),
        };
      });
      return jsonResult({ count: agents.length, agents });
    },
  );

  server.registerTool(
    "bridge_outbox",
    {
      title: "Check sent messages",
      description: "List direct messages an agent sent that the recipient has not acknowledged yet (newest first), with ping outcome and whether the recipient is active, retired or unknown.",
      inputSchema: {
        agent: z.string().min(1).describe("Sender whose outbox to read."),
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
        agent: z.string().min(1).describe("Agent to retire."),
        by: z.string().min(1).optional().describe("Who is retiring it. Defaults to this conversation's agent."),
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
    .describe("How long this call waits for Codex. Defaults to 240 seconds. If Codex is still working, the result arrives in the coordinator's mailbox.");
  const waitMs = (seconds: number | undefined) => (seconds === undefined ? DEFAULT_WAIT_MS : seconds * 1000);

  server.registerTool(
    "ask_codex",
    {
      title: "Ask Codex",
      description:
        "Send one bounded implementation, investigation, or verification task to a saved Codex worker in an isolated worktree. This is the simple everyday entry point; no mailbox or thread management is required.",
      inputSchema: {
        projectPath: z.string().min(1).optional().describe("Absolute path to the repository. Defaults to this session's project directory."),
        request: z.string().min(1).describe("What Codex should do."),
        coordinatorAgent: z.string().min(1).optional().describe("Agent that receives the result. Defaults to this conversation's registered agent, else claude-main."),
        threadId: z.string().min(1).optional().describe("Optional stable task ID. Generated when omitted."),
        useWorktree: z.boolean().optional().describe("Use an isolated Git worktree. Defaults true."),
        includeUncommitted: z.boolean().optional().describe("Copy the main checkout's uncommitted changes into the worktree."),
        waitSeconds,
      },
    },
    async ({ projectPath, request, coordinatorAgent, threadId, useWorktree, includeUncommitted, waitSeconds: seconds }) =>
      jsonResult(
        await orchestrator.start({
          coordinatorAgent: coordinatorAgent ?? defaultAgent(),
          projectPath: projectPath ?? projectFallback(),
          task: buildAskCodexTask(request),
          threadId: threadId ?? `ask-codex-${randomUUID()}`,
          useWorktree: useWorktree ?? true,
          includeUncommitted,
          maxRounds: 4,
          waitMs: waitMs(seconds),
        }),
      ),
  );

  server.registerTool(
    "review_with_codex",
    {
      title: "Review with Codex",
      description:
        "Ask Codex for a read-only repository review with evidence and actionable findings. Codex runs in a read-only sandbox and the bridge reports whether the workspace changed.",
      inputSchema: {
        projectPath: z.string().min(1).optional().describe("Absolute path to the repository. Defaults to this session's project directory."),
        focus: z.string().optional().describe("Optional review focus, such as security, a PR, or a subsystem."),
        coordinatorAgent: z.string().min(1).optional().describe("Agent that receives the result. Defaults to this conversation's registered agent, else claude-main."),
        threadId: z.string().min(1).optional().describe("Optional stable task ID. Generated when omitted."),
        waitSeconds,
      },
    },
    async ({ projectPath, focus, coordinatorAgent, threadId, waitSeconds: seconds }) =>
      jsonResult(
        await orchestrator.start({
          coordinatorAgent: coordinatorAgent ?? defaultAgent(),
          projectPath: projectPath ?? projectFallback(),
          task: buildCodexReviewTask(focus),
          threadId: threadId ?? `codex-review-${randomUUID()}`,
          useWorktree: false,
          sandbox: "read-only",
          maxRounds: 1,
          waitMs: waitMs(seconds),
        }),
      ),
  );

  server.registerTool(
    "bridge_orchestrate_codex",
    {
      title: "Start an autonomous Codex implementation run",
      description:
        "Start a saved Codex worker in an isolated git worktree (network off) and wait up to waitSeconds for its structured result. If status is waiting_for_fable, answer the question and call bridge_continue_codex. If it is running_codex, the result arrives in the coordinator's mailbox. Independent calls create separate runs. This tool never grants permission to commit, push, deploy, publish, send externally, change credentials, delete data, or mutate production.",
      inputSchema: {
        coordinatorAgent: z.string().min(1).optional().describe("Agent that receives the result. Defaults to this conversation's registered agent, else claude-main."),
        projectPath: z.string().min(1).optional().describe("Absolute path to the git repository. Defaults to this session's project directory."),
        task: z.string().min(1).describe("Self-contained implementation or verification task."),
        threadId: z.string().min(1).describe("Stable task/thread identifier."),
        useWorktree: z.boolean().optional().describe("Create an isolated git worktree. Defaults true."),
        includeUncommitted: z.boolean().optional().describe("Copy the main checkout's uncommitted changes into the worktree."),
        maxRounds: z.number().int().min(1).max(12).optional().describe("Maximum coordinator/Codex turns. Defaults 6."),
        waitSeconds,
      },
    },
    async ({ coordinatorAgent, projectPath, task, threadId, useWorktree, includeUncommitted, maxRounds, waitSeconds: seconds }) =>
      jsonResult(
        await orchestrator.start({
          coordinatorAgent: coordinatorAgent ?? defaultAgent(),
          projectPath: projectPath ?? projectFallback(),
          task,
          threadId,
          useWorktree: useWorktree ?? true,
          includeUncommitted,
          maxRounds: maxRounds ?? 6,
          waitMs: waitMs(seconds),
        }),
      ),
  );

  server.registerTool(
    "bridge_continue_codex",
    {
      title: "Continue Codex with the coordinator's answer",
      description:
        "Resume the exact saved Codex session and worktree after Codex asked for a decision (status waiting_for_fable). The sandbox from the first turn is kept. Continue until completed, blocked, failed, or the round limit is reached.",
      inputSchema: {
        runId: z.string().uuid().describe("Run ID returned by the orchestration tool."),
        fableAnswer: z.string().min(1).describe("The coordinator's concrete answer to Codex's question."),
        waitSeconds,
      },
    },
    async ({ runId, fableAnswer, waitSeconds: seconds }) =>
      jsonResult(await orchestrator.continueWithFable(runId, fableAnswer, waitMs(seconds))),
  );

  server.registerTool(
    "bridge_orchestration_wait",
    {
      title: "Wait for a Codex run",
      description: "Wait up to timeoutSeconds for a running Codex run to finish its current round, then return its result. Works for runs started by any bridge process.",
      inputSchema: {
        runId: z.string().uuid().describe("Orchestration run ID."),
        timeoutSeconds: z.number().int().min(0).max(285).optional().describe("Defaults to 240 seconds."),
      },
    },
    async ({ runId, timeoutSeconds }) => jsonResult(await orchestrator.wait(runId, waitMs(timeoutSeconds))),
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
    log(`received ${signal}, shutting down`);
    housekeeper.stop();
    orchestrator.close();
    void dispatcher.close().then(() => server.close()).finally(() => {
      store.close();
      process.exit(0);
    });
  };
  server.server.onclose = () => shutdown("transport closed");
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
