import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

import {
  BridgeStore,
  type OrchestrationRun,
  type OrchestrationStatus,
} from "./bridge-store.js";

export interface SuggestedChip {
  title: string;
  task: string;
}

export interface CodexTurnResponse {
  status: "completed" | "needs_fable" | "blocked";
  summary: string;
  evidence: string[];
  question?: string;
  filesChanged: string[];
  tests: string[];
  suggestedChips: SuggestedChip[];
}

export interface CodexRunner {
  start(input: {
    cwd: string;
    prompt: string;
  }): Promise<{ sessionId: string; response: CodexTurnResponse }>;
  resume(input: {
    cwd: string;
    sessionId: string;
    prompt: string;
  }): Promise<{ sessionId: string; response: CodexTurnResponse }>;
}

export interface WorkspaceManager {
  prepare(
    projectPath: string,
    useWorktree: boolean,
    runId: string,
    threadId?: string,
  ): Promise<{ path: string; branch: string | null }>;
}

export interface StartOrchestrationInput {
  coordinatorAgent: string;
  projectPath: string;
  task: string;
  threadId: string;
  useWorktree: boolean;
  maxRounds: number;
}

export interface OrchestrationResult {
  runId: string;
  status: OrchestrationStatus;
  round: number;
  maxRounds: number;
  codexSessionId: string | null;
  worktreePath: string;
  summary: string;
  question?: string;
  evidence: string[];
  filesChanged: string[];
  tests: string[];
  suggestedChips: SuggestedChip[];
}

const CODEX_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["completed", "needs_fable", "blocked"] },
    summary: { type: "string" },
    evidence: { type: "array", items: { type: "string" } },
    question: { type: "string" },
    filesChanged: { type: "array", items: { type: "string" } },
    tests: { type: "array", items: { type: "string" } },
    suggestedChips: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          task: { type: "string" },
        },
        required: ["title", "task"],
      },
    },
  },
  required: [
    "status",
    "summary",
    "evidence",
    "question",
    "filesChanged",
    "tests",
    "suggestedChips",
  ],
} as const;

export function buildSafeEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const common = ["PATH", "HOME", "USER", "USERNAME", "LANG", "LC_ALL", "TMPDIR", "SHELL"];
  const windows = [
    "USERPROFILE",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    "APPDATA",
    "LOCALAPPDATA",
  ];
  const allowed = platform === "win32" ? [...common, ...windows] : [...common, "XDG_DATA_HOME"];
  const env: NodeJS.ProcessEnv = { NO_COLOR: "1" };
  for (const key of allowed) {
    if (source[key]) env[key] = source[key];
  }
  return env;
}

export interface ResolveCodexBinaryInput {
  platform?: NodeJS.Platform;
  configuredBinary?: string;
  bundledMacExists?: boolean;
}

export function resolveCodexBinary(input: ResolveCodexBinaryInput = {}): string {
  if (input.configuredBinary?.trim()) return input.configuredBinary;
  const platform = input.platform ?? process.platform;
  const bundled = "/Applications/ChatGPT.app/Contents/Resources/codex";
  const bundledMacExists = input.bundledMacExists ?? (platform === "darwin" && existsSync(bundled));
  return bundledMacExists ? bundled : "codex";
}

function validateResponse(value: unknown): CodexTurnResponse {
  if (!value || typeof value !== "object") throw new Error("Codex response is not an object");
  const item = value as Record<string, unknown>;
  if (!(["completed", "needs_fable", "blocked"] as unknown[]).includes(item.status)) {
    throw new Error("Codex response has an invalid status");
  }
  if (typeof item.summary !== "string") throw new Error("Codex response is missing summary");
  for (const field of ["evidence", "filesChanged", "tests", "suggestedChips"]) {
    if (!Array.isArray(item[field])) throw new Error(`Codex response is missing ${field}`);
  }
  if (item.status === "needs_fable" && typeof item.question !== "string") {
    throw new Error("Codex requested Fable without a question");
  }
  return item as unknown as CodexTurnResponse;
}

export class CodexCliRunner implements CodexRunner {
  private readonly binary: string;
  private readonly dataDir: string;
  private readonly timeoutMs: number;
  private readonly schemaPath: string;

  constructor(options: { binary?: string; dataDir?: string; timeoutMs?: number } = {}) {
    this.binary = resolveCodexBinary({ configuredBinary: options.binary ?? process.env.CODEX_BIN });
    this.dataDir =
      options.dataDir ?? join(homedir(), ".local", "share", "claude-codex-bridge", "runs");
    this.timeoutMs = options.timeoutMs ?? 20 * 60 * 1000;
    mkdirSync(this.dataDir, { recursive: true });
    this.schemaPath = join(this.dataDir, "codex-turn.schema.json");
    writeFileSync(this.schemaPath, `${JSON.stringify(CODEX_OUTPUT_SCHEMA, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  async start(input: { cwd: string; prompt: string }) {
    return this.invoke(input.cwd, input.prompt, null);
  }

  async resume(input: { cwd: string; sessionId: string; prompt: string }) {
    return this.invoke(input.cwd, input.prompt, input.sessionId);
  }

  private async invoke(cwd: string, prompt: string, sessionId: string | null) {
    const invocationId = randomUUID();
    const outputPath = join(this.dataDir, `${invocationId}.json`);
    const common = [
      "-c",
      'approval_policy="never"',
      "--json",
      "-o",
      outputPath,
      "--output-schema",
      this.schemaPath,
    ];
    const args = sessionId
      ? ["exec", "resume", ...common, sessionId, "-"]
      : ["exec", "--sandbox", "workspace-write", ...common, "-"];

    const child = spawn(this.binary, args, {
      cwd,
      env: buildSafeEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end(prompt);

    let session = sessionId;
    let stdoutBuffer = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer = `${stdoutBuffer}${chunk}`;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          if (event.type === "thread.started" && typeof event.thread_id === "string") {
            session = event.thread_id;
          }
        } catch {
          // Ignore non-JSON diagnostics. The final response comes from outputPath.
        }
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-16_000);
    });

    const exitCode = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`Codex turn timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code ?? 1);
      });
    });

    if (exitCode !== 0) {
      throw new Error(`Codex exited ${exitCode}: ${stderr || "no diagnostic output"}`);
    }
    if (!session) throw new Error("Codex did not report a session ID");
    if (!existsSync(outputPath)) throw new Error("Codex did not write its final response");
    const response = validateResponse(JSON.parse(readFileSync(outputPath, "utf8")));
    return { sessionId: session, response };
  }
}

function runProcess(command: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: buildSafeEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} exited ${code}: ${stderr.trim()}`));
    });
  });
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 36) || "task";
}

export class GitWorkspaceManager implements WorkspaceManager {
  async prepare(projectPath: string, useWorktree: boolean, runId: string, threadId = "task") {
    if (!isAbsolute(projectPath)) throw new Error("projectPath must be absolute");
    await runProcess("git", ["-C", projectPath, "rev-parse", "--show-toplevel"]);
    if (!useWorktree) return { path: projectPath, branch: null };

    const shortId = runId.replace(/-/g, "").slice(0, 8);
    const name = `${slug(threadId)}-${shortId}`;
    const worktreeRoot = join(projectPath, ".bridge-worktrees");
    const worktreePath = join(worktreeRoot, name);
    const branch = `bridge/${name}`;
    mkdirSync(worktreeRoot, { recursive: true });
    if (!existsSync(worktreePath)) {
      await runProcess("git", ["-C", projectPath, "worktree", "add", "-b", branch, worktreePath, "HEAD"]);
    }
    return { path: worktreePath, branch };
  }
}

function basePrompt(task: string): string {
  return `You are a Codex implementation worker coordinated by Claude Fable 5.\n\nTASK:\n${task}\n\nSAFETY BOUNDARY:\n- Work only inside the supplied workspace.\n- Do not commit, push, merge, deploy, publish, send external messages, change credentials/configuration, delete data, or perform production mutations.\n- If any such action is required, return status blocked and explain exactly what approval is needed.\n- Run relevant tests and report real evidence.\n- If a hard architecture/reasoning decision needs Fable 5, return needs_fable with one precise question. Do not guess.\n- You may suggest up to three independent child chips, but do not launch them yourself.\n- Return only the required JSON envelope.`;
}

function continuationPrompt(answer: string): string {
  return `Claude Fable 5 answered your question:\n\n${answer}\n\nContinue the original task in the same workspace. Keep the same safety boundary. Run verification and return only the required JSON envelope. If another genuinely hard question remains, return needs_fable again.`;
}

export class Orchestrator {
  constructor(
    private readonly store: BridgeStore,
    private readonly runner: CodexRunner = new CodexCliRunner(),
    private readonly workspace: WorkspaceManager = new GitWorkspaceManager(),
  ) {}

  async start(input: StartOrchestrationInput): Promise<OrchestrationResult> {
    if (!input.coordinatorAgent.trim()) throw new Error("coordinatorAgent is required");
    if (!input.task.trim()) throw new Error("task is required");
    if (!input.threadId.trim()) throw new Error("threadId is required");
    if (input.maxRounds < 1 || input.maxRounds > 12) {
      throw new Error("maxRounds must be between 1 and 12");
    }

    const runId = randomUUID();
    const prepared = await this.workspace.prepare(
      input.projectPath,
      input.useWorktree,
      runId,
      input.threadId,
    );
    this.store.createRun({
      id: runId,
      coordinatorAgent: input.coordinatorAgent,
      projectPath: input.projectPath,
      worktreePath: prepared.path,
      threadId: input.threadId,
      task: input.task,
      status: "created",
      maxRounds: input.maxRounds,
    });
    this.store.appendRunEvent(runId, "created", {
      coordinatorAgent: input.coordinatorAgent,
      projectPath: input.projectPath,
      worktreePath: prepared.path,
      branch: prepared.branch,
      threadId: input.threadId,
    });
    this.store.updateRun(runId, { status: "running_codex", round: 1 });

    try {
      const turn = await this.runner.start({ cwd: prepared.path, prompt: basePrompt(input.task) });
      return this.applyTurn(runId, turn.sessionId, turn.response);
    } catch (error) {
      return this.fail(runId, error);
    }
  }

  async continueWithFable(runId: string, answer: string): Promise<OrchestrationResult> {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`Unknown orchestration run: ${runId}`);
    if (run.status !== "waiting_for_fable") {
      throw new Error(`Run ${runId} is not waiting for Fable`);
    }
    if (!run.codexSessionId) throw new Error(`Run ${runId} has no Codex session ID`);
    if (run.round >= run.maxRounds) {
      const blocked = this.store.updateRun(runId, {
        status: "blocked",
        latestResponse: { summary: "Fable/Codex round limit reached" },
      });
      this.store.appendRunEvent(runId, "round_limit", { round: run.round, maxRounds: run.maxRounds });
      return this.resultFromRun(blocked, "Fable/Codex round limit reached");
    }

    const nextRound = run.round + 1;
    this.store.appendRunEvent(runId, "fable_answer", { round: nextRound, answer });
    this.store.updateRun(runId, { status: "running_codex", round: nextRound });
    try {
      const turn = await this.runner.resume({
        cwd: run.worktreePath,
        sessionId: run.codexSessionId,
        prompt: continuationPrompt(answer),
      });
      return this.applyTurn(runId, turn.sessionId, turn.response);
    } catch (error) {
      return this.fail(runId, error);
    }
  }

  status(runId: string) {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`Unknown orchestration run: ${runId}`);
    return { run, events: this.store.runEvents(runId) };
  }

  private applyTurn(
    runId: string,
    sessionId: string,
    response: CodexTurnResponse,
  ): OrchestrationResult {
    const status: OrchestrationStatus =
      response.status === "needs_fable" ? "waiting_for_fable" : response.status;
    const run = this.store.updateRun(runId, {
      status,
      codexSessionId: sessionId,
      latestResponse: response as unknown as Record<string, unknown>,
    });
    this.store.appendRunEvent(runId, "codex_turn", {
      round: run.round,
      status: response.status,
      summary: response.summary,
      question: response.question ?? null,
      evidence: response.evidence,
      filesChanged: response.filesChanged,
      tests: response.tests,
      suggestedChips: response.suggestedChips,
    });
    return this.resultFromRun(run, response.summary, response);
  }

  private fail(runId: string, error: unknown): OrchestrationResult {
    const message = error instanceof Error ? error.message : String(error);
    const run = this.store.updateRun(runId, {
      status: "failed",
      latestResponse: { summary: message },
    });
    this.store.appendRunEvent(runId, "failed", { message });
    return this.resultFromRun(run, message);
  }

  private resultFromRun(
    run: OrchestrationRun,
    summary: string,
    response?: CodexTurnResponse,
  ): OrchestrationResult {
    const latest = response ?? (run.latestResponse as unknown as Partial<CodexTurnResponse> | null);
    return {
      runId: run.id,
      status: run.status,
      round: run.round,
      maxRounds: run.maxRounds,
      codexSessionId: run.codexSessionId,
      worktreePath: run.worktreePath,
      summary,
      question: latest?.question,
      evidence: latest?.evidence ?? [],
      filesChanged: latest?.filesChanged ?? [],
      tests: latest?.tests ?? [],
      suggestedChips: latest?.suggestedChips ?? [],
    };
  }
}
