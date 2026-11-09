import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import type { TurnFiles } from "./bridge-store.js";
import { claudeBinaryPath } from "./claude-binary.js";
import {
  CODEX_OUTPUT_SCHEMA,
  DetachedTurnRunner,
  readTail,
  validateResponse,
  type CodexTurnRequest,
  type CodexTurnResponse,
  type DetachedCommand,
  type TurnOutcome,
} from "./orchestrator.js";
import type { ClaudePermissionMode } from "./worker-policy.js";

/** Reasoning efforts the Claude Code CLI accepts. */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * Claude Code arguments for one headless worker turn. The prompt arrives on
 * stdin. Workers run without MCP servers: their result returns through the
 * envelope, and a worker that could reach the bridge could start more workers.
 */
export function buildClaudeArgs(input: {
  sessionId: string;
  resume: boolean;
  permissionMode: ClaudePermissionMode;
  model?: string | null;
  effort?: string | null;
  title?: string | null;
}): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    ...(input.resume ? ["--resume", input.sessionId] : ["--session-id", input.sessionId]),
    "--permission-mode",
    input.permissionMode,
    ...(input.model ? ["--model", input.model] : []),
    ...(input.effort ? ["--effort", input.effort] : []),
    ...(input.title && !input.resume ? ["--name", input.title] : []),
    "--json-schema",
    JSON.stringify(CODEX_OUTPUT_SCHEMA),
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
  ];
}

type Json = Record<string, unknown>;

/** The single result object `claude -p --output-format json` prints. */
function readResult(path: string): Json | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const candidates = [...text.split("\n").reverse(), text];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as Json;
      if (parsed.type === "result") return parsed;
    } catch {
      // Not the result line.
    }
  }
  return null;
}

function parseObject(text: string): unknown {
  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (!unfenced.startsWith("{")) return null;
  try {
    return JSON.parse(unfenced);
  } catch {
    return null;
  }
}

/** The worker envelope, or the plain answer wrapped in one when Claude did not use the schema. */
export function claudeEnvelope(result: Json): CodexTurnResponse {
  const text = typeof result.result === "string" ? result.result.trim() : "";
  for (const candidate of [result.structured_output, parseObject(text)]) {
    if (!candidate || typeof candidate !== "object") continue;
    try {
      return validateResponse(candidate);
    } catch {
      // Fall through to the plain answer.
    }
  }
  return {
    status: "completed",
    summary: text || "Claude finished without a written answer.",
    evidence: [],
    filesChanged: [],
    tests: [],
    suggestedChips: [],
  };
}

function denialWarnings(result: Json): string[] {
  const denials = Array.isArray(result.permission_denials) ? (result.permission_denials as Json[]) : [];
  if (denials.length === 0) return [];
  const tools = [...new Set(denials.map((denial) => String(denial.tool_name ?? "a tool")))].slice(0, 8).join(", ");
  return [
    `Claude's permission mode refused ${denials.length} tool call(s) (${tools}), so part of the task may be undone. A higher permissionMode, within the owner's policy, allows more.`,
  ];
}

/**
 * Claude worker turns through headless Claude Code (`claude -p`). The chat is
 * saved under the CLI's own session list; `showInClaudeDesktop` can then hand
 * it to the desktop app.
 */
export class ClaudeCliRunner extends DetachedTurnRunner {
  protected override readonly label = "Claude";
  readonly binary: string;

  constructor(options: { binary?: string; dataDir?: string; timeoutMs?: number } = {}) {
    super(options);
    this.binary = options.binary ?? claudeBinaryPath();
  }

  /** Claude Code accepts a session ID up front, so the bridge knows it before the turn ends. */
  protected override newSessionId(): string {
    return randomUUID();
  }

  protected override reportedSessionId(): string | null {
    return null;
  }

  protected command(request: CodexTurnRequest, _files: TurnFiles, sessionId: string | null): DetachedCommand {
    return {
      command: this.binary,
      args: buildClaudeArgs({
        sessionId: sessionId as string,
        resume: request.sessionId !== null,
        permissionMode: request.permissionMode ?? (request.sandbox === "read-only" ? "plan" : "acceptEdits"),
        model: request.model,
        effort: request.effort,
        title: request.title,
      }),
    };
  }

  protected collect(files: TurnFiles, knownSessionId: string | null, exitCode: number | null): TurnOutcome {
    const result = readResult(files.eventsPath);
    if (!result) {
      const detail = readTail(files.stderrPath, 2000) || readTail(files.eventsPath, 2000) || "no output";
      throw new Error(exitCode === null ? `Claude did not write a result: ${detail}` : `Claude exited ${exitCode}: ${detail}`);
    }
    if (result.is_error) {
      const reason = String(result.result ?? result.subtype ?? "unknown error");
      const hint = /authenticat|oauth|log ?in|api key/i.test(reason)
        ? " The Claude Code CLI needs its own sign-in: run `claude auth login` once. The desktop app's sign-in does not cover it."
        : "";
      throw new Error(`Claude could not run the turn: ${reason}.${hint}`);
    }
    const sessionId = typeof result.session_id === "string" ? result.session_id : knownSessionId;
    if (!sessionId) throw new Error("Claude did not report a session ID");
    const warnings = denialWarnings(result);
    return { sessionId, response: claudeEnvelope(result), ...(warnings.length ? { warnings } : {}) };
  }
}
