#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { BridgeStore } from "./bridge-store.js";
import { waitForInbox } from "./inbox-waiter.js";
import { Orchestrator } from "./orchestrator.js";
import { buildAskCodexTask, buildCodexReviewTask } from "./simple-tools.js";

/**
 * Resolve the shared SQLite database path. BRIDGE_DB_PATH takes precedence;
 * otherwise fall back to a per-user location under the home directory
 * (honouring XDG_DATA_HOME when set).
 */
function resolveDbPath(): string {
  const override = process.env.BRIDGE_DB_PATH;
  if (override && override.trim() !== "") {
    return override;
  }
  const dataHome =
    process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.trim() !== ""
      ? process.env.XDG_DATA_HOME
      : join(homedir(), ".local", "share");
  return join(dataHome, "claude-codex-bridge", "bridge.sqlite");
}

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

function main(): void {
  const dbPath = resolveDbPath();
  const store = new BridgeStore(dbPath);
  const orchestrator = new Orchestrator(store);
  log(`store ready at ${dbPath}`);

  const server = new McpServer(
    {
      name: "claude-codex-bridge",
      version: "0.2.0",
    },
    {
      instructions:
        "Local Claude/Fable and Codex coordination bridge. For live two-chat coordination, never end a turn and later ask the user to tell you to read messages: after bridge_send or after handling a returned message, call bridge_wait for the same agent and thread before going idle; when it returns, handle, reply, and wait again until completed, blocked, approval-required, or explicitly stopped. For autonomous implementation, the active Claude Fable coordinator calls bridge_orchestrate_codex. If it returns waiting_for_fable, answer the precise question yourself (or use a Claude chip) and immediately call bridge_continue_codex with the same runId. Repeat without asking the user unless status is blocked, failed, or completed. When Codex returns independent suggestedChips that are necessary for the user's task, automatically start up to three separate bridge_orchestrate_codex calls, each with its own thread and worktree. Never treat this bridge as permission to commit, push, deploy, publish, send externally, change credentials, delete data, or mutate production.",
    },
  );

  server.registerTool(
    "bridge_register",
    {
      title: "Register agent presence",
      description:
        "Announce an agent and its capabilities so others can discover it.",
      inputSchema: {
        agent: z.string().min(1).describe("Unique agent name, e.g. 'claude'."),
        capabilities: z
          .array(z.string())
          .optional()
          .describe("Skills this agent offers, e.g. ['review','architecture']."),
      },
    },
    async ({ agent, capabilities }) => {
      const registered = store.register(agent, capabilities ?? []);
      return jsonResult(registered);
    },
  );

  server.registerTool(
    "bridge_send",
    {
      title: "Send a message",
      description:
        "Deliver a message to another agent. Use '*' to broadcast to everyone.",
      inputSchema: {
        from: z.string().min(1).describe("Sender agent name."),
        to: z
          .string()
          .min(1)
          .describe("Recipient agent name, or '*' to broadcast."),
        body: z.string().min(1).describe("Message content."),
        threadId: z
          .string()
          .optional()
          .describe("Optional conversation thread identifier."),
        idempotencyKey: z
          .string()
          .optional()
          .describe("Optional key to prevent duplicate delivery on retry."),
      },
    },
    async ({ from, to, body, threadId, idempotencyKey }) => {
      const message = store.send({
        fromAgent: from,
        toAgent: to,
        body,
        threadId: threadId ?? null,
        idempotencyKey: idempotencyKey ?? null,
      });
      return jsonResult(message);
    },
  );

  server.registerTool(
    "bridge_inbox",
    {
      title: "Read inbox",
      description:
        "List messages addressed to an agent. Acknowledged messages are hidden by default.",
      inputSchema: {
        agent: z.string().min(1).describe("Agent whose inbox to read."),
        includeAcknowledged: z
          .boolean()
          .optional()
          .describe("Include messages this agent has already acknowledged."),
      },
    },
    async ({ agent, includeAcknowledged }) => {
      const messages = store.inbox(agent, {
        includeAcknowledged: includeAcknowledged ?? false,
      });
      return jsonResult({ count: messages.length, messages });
    },
  );

  server.registerTool(
    "bridge_wait",
    {
      title: "Wait for the next bridge message",
      description:
        "Keep this agent turn alive until a matching bridge message arrives. Use this instead of ending the turn and later asking the user to tell you to read the inbox. After handling and replying to the returned message, call bridge_wait again automatically if the coordination thread is still active. This is the MCP push-style handoff: the tool blocks efficiently and returns as soon as the other agent sends. It cannot wake a chat whose turn has already ended, so enter bridge_wait before going idle.",
      inputSchema: {
        agent: z.string().min(1).describe("Agent whose inbox should wake this turn."),
        fromAgent: z.string().min(1).optional().describe("Optional sender filter."),
        threadId: z.string().min(1).optional().describe("Optional coordination thread filter."),
        timeoutSeconds: z
          .number()
          .int()
          .min(1)
          .max(290)
          .optional()
          .describe("How long to keep the MCP call open. Defaults to 285 seconds so common five-minute host limits do not cut it off."),
        acknowledge: z
          .boolean()
          .optional()
          .describe("Mark returned messages handled before returning. Defaults true; history is preserved."),
      },
    },
    async ({ agent, fromAgent, threadId, timeoutSeconds, acknowledge }) => {
      const result = await waitForInbox(store, {
        agent,
        fromAgent,
        threadId,
        timeoutMs: (timeoutSeconds ?? 285) * 1000,
      });
      const acknowledged =
        (acknowledge ?? true) && result.messages.length > 0
          ? store.ack(
              agent,
              result.messages.map((message) => message.id),
            )
          : 0;
      return jsonResult({
        timedOut: result.timedOut,
        count: result.messages.length,
        acknowledged,
        messages: result.messages,
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
      description:
        "Mark messages as read for an agent so they drop out of the unread inbox.",
      inputSchema: {
        agent: z.string().min(1).describe("Agent acknowledging the messages."),
        ids: z
          .array(z.number().int().positive())
          .min(1)
          .describe("Message ids to acknowledge."),
      },
    },
    async ({ agent, ids }) => {
      const acknowledged = store.ack(agent, ids);
      return jsonResult({ acknowledged });
    },
  );

  server.registerTool(
    "bridge_thread",
    {
      title: "Read a thread",
      description: "Return the full history of a conversation thread, oldest first.",
      inputSchema: {
        threadId: z.string().min(1).describe("Thread identifier to fetch."),
      },
    },
    async ({ threadId }) => {
      const messages = store.thread(threadId);
      return jsonResult({ threadId, count: messages.length, messages });
    },
  );

  server.registerTool(
    "bridge_agents",
    {
      title: "List agents",
      description: "List all registered agents and their capabilities.",
      inputSchema: {},
    },
    async () => {
      const agents = store.agents();
      return jsonResult({ count: agents.length, agents });
    },
  );

  server.registerTool(
    "ask_codex",
    {
      title: "Ask Codex",
      description:
        "Send one bounded implementation, investigation, or verification task to a saved Codex worker. This is the simple everyday entry point; no mailbox or thread management is required.",
      inputSchema: {
        projectPath: z.string().min(1).describe("Absolute path to the repository or project."),
        request: z.string().min(1).describe("What Codex should do."),
        coordinatorAgent: z.string().min(1).optional().describe("Coordinator name. Defaults to claude-main."),
        threadId: z.string().min(1).optional().describe("Optional stable task ID. Generated when omitted."),
        useWorktree: z.boolean().optional().describe("Use an isolated Git worktree. Defaults true."),
      },
    },
    async ({ projectPath, request, coordinatorAgent, threadId, useWorktree }) =>
      jsonResult(
        await orchestrator.start({
          coordinatorAgent: coordinatorAgent ?? "claude-main",
          projectPath,
          task: buildAskCodexTask(request),
          threadId: threadId ?? `ask-codex-${randomUUID()}`,
          useWorktree: useWorktree ?? true,
          maxRounds: 4,
        }),
      ),
  );

  server.registerTool(
    "review_with_codex",
    {
      title: "Review with Codex",
      description:
        "Ask Codex for a read-only repository review with evidence and actionable findings. No mailbox setup is required and Codex is instructed not to edit files.",
      inputSchema: {
        projectPath: z.string().min(1).describe("Absolute path to the repository."),
        focus: z.string().optional().describe("Optional review focus, such as security, a PR, or a subsystem."),
        coordinatorAgent: z.string().min(1).optional().describe("Coordinator name. Defaults to claude-main."),
        threadId: z.string().min(1).optional().describe("Optional stable task ID. Generated when omitted."),
      },
    },
    async ({ projectPath, focus, coordinatorAgent, threadId }) =>
      jsonResult(
        await orchestrator.start({
          coordinatorAgent: coordinatorAgent ?? "claude-main",
          projectPath,
          task: buildCodexReviewTask(focus),
          threadId: threadId ?? `codex-review-${randomUUID()}`,
          useWorktree: false,
          maxRounds: 1,
        }),
      ),
  );

  server.registerTool(
    "bridge_orchestrate_codex",
    {
      title: "Start an autonomous Codex implementation run",
      description:
        "Start a saved Codex worker session in an isolated git worktree and wait for its structured result. If status is waiting_for_fable, the active Claude/Fable coordinator should answer the returned question and immediately call bridge_continue_codex. Independent calls create separate Codex chips. This tool never grants permission to commit, push, deploy, publish, send externally, change credentials, delete data, or mutate production.",
      inputSchema: {
        coordinatorAgent: z.string().min(1).describe("Name of the active Claude coordinator."),
        projectPath: z.string().min(1).describe("Absolute path to the git repository."),
        task: z.string().min(1).describe("Self-contained implementation or verification task."),
        threadId: z.string().min(1).describe("Stable task/thread identifier."),
        useWorktree: z.boolean().optional().describe("Create an isolated git worktree. Defaults true."),
        maxRounds: z.number().int().min(1).max(12).optional().describe("Maximum Fable/Codex turns. Defaults 6."),
      },
    },
    async ({ coordinatorAgent, projectPath, task, threadId, useWorktree, maxRounds }) =>
      jsonResult(
        await orchestrator.start({
          coordinatorAgent,
          projectPath,
          task,
          threadId,
          useWorktree: useWorktree ?? true,
          maxRounds: maxRounds ?? 6,
        }),
      ),
  );

  server.registerTool(
    "bridge_continue_codex",
    {
      title: "Continue Codex with Fable's answer",
      description:
        "Resume the exact saved Codex session and worktree after Codex asked Fable for help. Call this automatically in the same Claude turn after answering the question returned by bridge_orchestrate_codex. Continue until completed, blocked, failed, or the round limit is reached.",
      inputSchema: {
        runId: z.string().uuid().describe("Run ID returned by the orchestration tool."),
        fableAnswer: z.string().min(1).describe("Fable's concrete answer to Codex's question."),
      },
    },
    async ({ runId, fableAnswer }) =>
      jsonResult(await orchestrator.continueWithFable(runId, fableAnswer)),
  );

  server.registerTool(
    "bridge_orchestration_status",
    {
      title: "Inspect an orchestration run",
      description:
        "Recover durable run state and its audit events after a restart or when checking progress.",
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
    void server.close().finally(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  server
    .connect(transport)
    .then(() => log("connected over stdio"))
    .catch((error: unknown) => {
      log(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      store.close();
      process.exit(1);
    });
}

main();
