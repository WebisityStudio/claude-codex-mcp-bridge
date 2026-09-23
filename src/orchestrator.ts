import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  BridgeStore,
  type OrchestrationRun,
  type OrchestrationStatus,
  type SandboxMode,
  type TurnFiles,
} from "./bridge-store.js";
import { ensurePrivateDirectory } from "./fs-safety.js";
import { BRIDGE_AGENT } from "./notices.js";
import { runsDir, worktreeRoot } from "./paths.js";
import { isProcessAlive, processStartTime, terminateProcessTree } from "./process-info.js";

export type { SandboxMode } from "./bridge-store.js";

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

export interface CodexTurnRequest {
  cwd: string;
  prompt: string;
  /** Resume this saved session, or start a new one when null. */
  sessionId: string | null;
  sandbox: SandboxMode;
}

export interface TurnHooks {
  onSpawn?(info: { pid: number | null; started: string | null; files: TurnFiles | null }): void;
  onSession?(sessionId: string): void;
}

export interface TurnOutcome {
  sessionId: string;
  response: CodexTurnResponse;
}

export interface CodexRunner {
  /** Longest a single turn may run before it is stopped. */
  readonly turnTimeoutMs: number;
  run(request: CodexTurnRequest, hooks?: TurnHooks): Promise<TurnOutcome>;
  /** Finish a turn from its files after the process that launched it exited. */
  recover?(files: TurnFiles, knownSessionId: string | null): TurnOutcome;
}

export interface PrepareInput {
  projectPath: string;
  useWorktree: boolean;
  runId: string;
  threadId: string;
  includeUncommitted?: boolean;
}

export interface PreparedWorkspace {
  path: string;
  branch: string | null;
  baseCommit: string | null;
  uncommitted: string[];
  includedUncommitted: boolean;
  warnings: string[];
}

export interface WorkspaceManager {
  prepare(input: PrepareInput): Promise<PreparedWorkspace>;
  /** `git status --porcelain` lines for the workspace, or null when unavailable. */
  changes(path: string): Promise<string[] | null>;
}

export interface StartOrchestrationInput {
  coordinatorAgent: string;
  projectPath: string;
  task: string;
  threadId: string;
  useWorktree: boolean;
  maxRounds: number;
  sandbox?: SandboxMode;
  includeUncommitted?: boolean;
  /** How long this call waits for the turn before returning running_codex. */
  waitMs?: number;
}

export interface OrchestrationResult {
  runId: string;
  status: OrchestrationStatus;
  round: number;
  maxRounds: number;
  codexSessionId: string | null;
  worktreePath: string;
  branch: string | null;
  baseCommit: string | null;
  sandbox: SandboxMode;
  summary: string;
  question?: string;
  evidence: string[];
  filesChanged: string[];
  tests: string[];
  suggestedChips: SuggestedChip[];
  /** `git status` in the workspace as observed by the bridge, not reported by Codex. */
  observedChanges: string[] | null;
  warnings: string[];
  next?: string;
}

/** Stay below the ~5 minute limit common MCP hosts apply to one tool call. */
export const DEFAULT_WAIT_MS = 240_000;
export const MAX_WAIT_MS = 285_000;

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

/** Config keys a worker override may never change: they carry the safety boundary. */
const PROTECTED_CONFIG = /^(sandbox_mode|approval_policy|sandbox_workspace_write|sandbox_permissions|shell_environment_policy)\b/;

/**
 * Optional `key=value` Codex overrides for bridge workers, separated by `;` or
 * newlines, e.g. `model_reasoning_effort="medium"`. Safety keys are dropped.
 */
export function parseExtraCodexConfig(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value
    .split(/[;\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => {
      const separator = entry.indexOf("=");
      return separator > 0 && !PROTECTED_CONFIG.test(entry.slice(0, separator).trim());
    });
}

/**
 * Codex CLI arguments for one turn. The sandbox is pinned on every turn:
 * `codex exec resume` has no --sandbox flag and otherwise falls back to the
 * user's config.toml default, which may be danger-full-access. Pinned values
 * come after any extra config so they always win.
 */
export function buildCodexArgs(input: {
  sessionId: string | null;
  sandbox: SandboxMode;
  outputPath: string;
  schemaPath: string;
  extraConfig?: string[];
}): string[] {
  const config = [
    ...(input.extraConfig ?? []).flatMap((entry) => ["-c", entry]),
    "-c",
    'approval_policy="never"',
    "-c",
    `sandbox_mode="${input.sandbox}"`,
  ];
  if (input.sandbox === "workspace-write") {
    config.push("-c", "sandbox_workspace_write.network_access=false");
  }
  const output = ["--json", "-o", input.outputPath, "--output-schema", input.schemaPath];
  return input.sessionId
    ? ["exec", "resume", ...config, ...output, input.sessionId, "-"]
    : ["exec", "--sandbox", input.sandbox, ...config, ...output, "-"];
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

function readHead(path: string, bytes: number): string {
  try {
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(bytes);
      const read = readSync(fd, buffer, 0, bytes, 0);
      return buffer.subarray(0, read).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

function readTail(path: string, bytes: number): string {
  try {
    const size = statSync(path).size;
    const fd = openSync(path, "r");
    try {
      const length = Math.min(size, bytes);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      return buffer.toString("utf8").trim();
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

/** Codex reports its session ID in the first JSONL event. */
export function readSessionId(eventsPath: string): string | null {
  for (const line of readHead(eventsPath, 256 * 1024).split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "thread.started" && typeof event.thread_id === "string") return event.thread_id;
    } catch {
      // Ignore partial or non-JSON lines.
    }
  }
  return null;
}

/**
 * Runs Codex turns as detached processes that write to files. If the MCP
 * process exits mid-turn, Codex keeps working and any bridge process can
 * finish the run from those files.
 */
export class CodexCliRunner implements CodexRunner {
  private readonly binary: string;
  private readonly dataDir: string;
  private readonly schemaPath: string;
  private readonly extraConfig: string[];
  readonly turnTimeoutMs: number;

  constructor(options: { binary?: string; dataDir?: string; timeoutMs?: number; extraConfig?: string[] } = {}) {
    this.binary = resolveCodexBinary({ configuredBinary: options.binary ?? process.env.CODEX_BIN });
    this.extraConfig = options.extraConfig ?? parseExtraCodexConfig(process.env.BRIDGE_CODEX_CONFIG);
    this.dataDir = options.dataDir ?? runsDir();
    const configuredMinutes = Number(process.env.BRIDGE_CODEX_TURN_TIMEOUT_MINUTES);
    this.turnTimeoutMs =
      options.timeoutMs ??
      (Number.isFinite(configuredMinutes) && configuredMinutes > 0 ? configuredMinutes * 60_000 : 20 * 60_000);
    ensurePrivateDirectory(this.dataDir);
    this.schemaPath = join(this.dataDir, "codex-turn.schema.json");
    writeFileSync(this.schemaPath, `${JSON.stringify(CODEX_OUTPUT_SCHEMA, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  async run(request: CodexTurnRequest, hooks: TurnHooks = {}): Promise<TurnOutcome> {
    const id = randomUUID();
    const files: TurnFiles = {
      outputPath: join(this.dataDir, `${id}.json`),
      eventsPath: join(this.dataDir, `${id}.events.jsonl`),
      stderrPath: join(this.dataDir, `${id}.stderr.log`),
    };
    const eventsFd = openSync(files.eventsPath, "w", 0o600);
    const stderrFd = openSync(files.stderrPath, "w", 0o600);
    let child;
    try {
      child = spawn(
        this.binary,
        buildCodexArgs({
          sessionId: request.sessionId,
          sandbox: request.sandbox,
          outputPath: files.outputPath,
          schemaPath: this.schemaPath,
          extraConfig: this.extraConfig,
        }),
        {
          cwd: request.cwd,
          env: buildSafeEnvironment(),
          stdio: ["pipe", eventsFd, stderrFd],
          detached: process.platform !== "win32",
        },
      );
    } finally {
      closeSync(eventsFd);
      closeSync(stderrFd);
    }
    const exited = new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
    exited.catch(() => {}); // Observed below; never an unhandled rejection.
    child.stdin?.on("error", () => {});
    child.stdin?.end(request.prompt);
    child.unref();
    hooks.onSpawn?.({ pid: child.pid ?? null, started: await processStartTime(child.pid), files });

    let reported = request.sessionId;
    const watch = setInterval(() => {
      const sessionId = readSessionId(files.eventsPath);
      if (sessionId && sessionId !== reported) {
        reported = sessionId;
        hooks.onSession?.(sessionId);
      }
    }, 500);
    watch.unref();
    let deadline: NodeJS.Timeout | undefined;
    try {
      const code = await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => {
            if (child.pid) terminateProcessTree(child.pid);
            reject(new Error(`Codex turn timed out after ${Math.round(this.turnTimeoutMs / 60_000)} minutes`));
          }, this.turnTimeoutMs);
        }),
      ]);
      return this.collect(files, request.sessionId, code);
    } finally {
      clearInterval(watch);
      clearTimeout(deadline);
    }
  }

  recover(files: TurnFiles, knownSessionId: string | null): TurnOutcome {
    return this.collect(files, knownSessionId, null);
  }

  private collect(files: TurnFiles, knownSessionId: string | null, exitCode: number | null): TurnOutcome {
    if (exitCode !== null && exitCode !== 0) {
      throw new Error(`Codex exited ${exitCode}: ${readTail(files.stderrPath, 4000) || "no diagnostic output"}`);
    }
    const sessionId = readSessionId(files.eventsPath) ?? knownSessionId;
    if (!sessionId) throw new Error("Codex did not report a session ID");
    if (!existsSync(files.outputPath)) throw new Error("Codex did not write its final response");
    return { sessionId, response: validateResponse(JSON.parse(readFileSync(files.outputPath, "utf8"))) };
  }
}

function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string; input?: string; trim?: boolean } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: buildSafeEnvironment(),
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    // stdout and stderr are always pipes here.
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => (stdout += chunk));
    child.stderr!.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(options.trim === false ? stdout : stdout.trim());
      else reject(new Error(`${command} ${args[0] === "-C" ? args[2] : args[0]} exited ${code}: ${stderr.trim()}`));
    });
    if (options.input !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(options.input);
    }
  });
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 36) || "task";
}

/** Legacy in-repository worktree directory from bridge 0.3; never reported as a change. */
const LEGACY_WORKTREE_DIR = ".bridge-worktrees/";

export class GitWorkspaceManager implements WorkspaceManager {
  constructor(private readonly root: string = worktreeRoot()) {}

  async prepare(input: PrepareInput): Promise<PreparedWorkspace> {
    if (!isAbsolute(input.projectPath)) throw new Error("projectPath must be absolute");
    const top = await runProcess("git", ["-C", input.projectPath, "rev-parse", "--show-toplevel"]);
    const baseCommit = await runProcess("git", ["-C", top, "rev-parse", "--verify", "HEAD"]).catch(() => null);
    const uncommitted = (await this.changes(top)) ?? [];
    if (!input.useWorktree) {
      return { path: input.projectPath, branch: null, baseCommit, uncommitted, includedUncommitted: true, warnings: [] };
    }
    if (!baseCommit) {
      throw new Error("The repository has no commits yet, so a worktree has no base. Commit first or use useWorktree: false.");
    }

    const shortId = input.runId.replace(/-/g, "").slice(0, 8);
    const name = `${slug(input.threadId)}-${shortId}`;
    const repoKey = `${slug(basename(top))}-${createHash("sha256").update(top).digest("hex").slice(0, 8)}`;
    ensurePrivateDirectory(this.root);
    const repoRoot = join(this.root, repoKey);
    mkdirSync(repoRoot, { recursive: true, mode: 0o700 });
    const worktreePath = join(repoRoot, name);
    const branch = `bridge/${name}`;
    if (!existsSync(worktreePath)) {
      await runProcess("git", ["-C", top, "worktree", "add", "-b", branch, worktreePath, baseCommit]);
    }

    const warnings: string[] = [];
    let includedUncommitted = false;
    if (uncommitted.length > 0) {
      if (input.includeUncommitted) {
        try {
          await this.copyUncommitted(top, worktreePath);
          includedUncommitted = true;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          warnings.push(`Could not copy the main checkout's uncommitted changes (${reason}). The worktree starts from commit ${baseCommit.slice(0, 12)}.`);
        }
      } else {
        warnings.push(
          `The main checkout has ${uncommitted.length} uncommitted change(s) that are not in this worktree; it starts from commit ${baseCommit.slice(0, 12)}. Pass includeUncommitted: true to copy them in.`,
        );
      }
    }
    // Keep the caller's subdirectory when projectPath points inside the repository.
    // Git reports it directly, so symlinks, case and Windows short names cannot confuse it.
    const prefix = (await runProcess("git", ["-C", input.projectPath, "rev-parse", "--show-prefix"])).replace(/[\\/]+$/, "");
    const path = prefix ? join(worktreePath, prefix) : worktreePath;
    return { path, branch, baseCommit, uncommitted, includedUncommitted, warnings };
  }

  private async copyUncommitted(top: string, worktreePath: string): Promise<void> {
    const patch = await runProcess("git", ["-C", top, "diff", "--binary", "HEAD"], { trim: false });
    if (patch.trim()) {
      await runProcess("git", ["-C", worktreePath, "apply", "--binary", "--whitespace=nowarn", "-"], { input: patch });
    }
    const untracked = await runProcess("git", ["-C", top, "ls-files", "--others", "--exclude-standard", "-z"], {
      trim: false,
    });
    for (const file of untracked.split("\0").filter(Boolean)) {
      if (file.startsWith(LEGACY_WORKTREE_DIR)) continue;
      const target = join(worktreePath, file);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(top, file), target);
    }
  }

  async changes(path: string): Promise<string[] | null> {
    try {
      const output = await runProcess("git", ["-C", path, "status", "--porcelain=v1", "--untracked-files=all"], {
        trim: false,
      });
      return output
        .split("\n")
        .filter((line) => line.trim() && !line.slice(3).startsWith(LEGACY_WORKTREE_DIR))
        .slice(0, 500);
    } catch {
      return null;
    }
  }
}

function basePrompt(task: string, context: { sandbox: SandboxMode; warnings: string[] }): string {
  const workspace =
    context.sandbox === "read-only"
      ? "- Your sandbox is read-only. Inspect files and run read-only commands; do not try to edit anything."
      : "- Work only inside the supplied workspace. Network access is disabled.";
  const notes = context.warnings.length
    ? `\n\nWORKSPACE NOTES:\n${context.warnings.map((warning) => `- ${warning}`).join("\n")}`
    : "";
  return `You are a Codex worker coordinated by a Claude session through claude-codex-bridge.\n\nTASK:\n${task}${notes}\n\nSAFETY BOUNDARY:\n${workspace}\n- Do not commit, push, merge, deploy, publish, send external messages, change credentials/configuration, delete data, or perform production mutations.\n- If any such action is required, return status blocked and explain exactly what approval is needed.\n- Run relevant tests and report real evidence.\n- If a hard architecture/reasoning decision needs the coordinator, return needs_fable with one precise question. Do not guess.\n- You may suggest up to three independent child chips, but do not launch them yourself.\n- Return only the required JSON envelope.`;
}

function continuationPrompt(answer: string): string {
  return `The coordinating Claude session answered your question:\n\n${answer}\n\nContinue the original task in the same workspace. Keep the same safety boundary. Run verification and return only the required JSON envelope. If another genuinely hard question remains, return needs_fable again.`;
}

function list(items: string[] | null | undefined, max = 12): string {
  if (!items || items.length === 0) return "none";
  const shown = items.slice(0, max).join("; ");
  return items.length > max ? `${shown}; and ${items.length - max} more` : shown;
}

/** The mailbox message a coordinator receives when a background run finishes a round. */
export function runResultMessage(result: OrchestrationResult, threadId: string): string {
  const lines = [
    `Codex run ${result.runId} (thread ${JSON.stringify(threadId)}) finished round ${result.round} of ${result.maxRounds}: ${result.status}.`,
    `Summary: ${result.summary}`,
  ];
  if (result.status === "waiting_for_fable" && result.question) {
    lines.push(
      `Codex asks: ${result.question}`,
      `Answer with bridge_continue_codex {"runId": "${result.runId}", "fableAnswer": "..."}.`,
    );
  }
  lines.push(
    `Files changed (reported by Codex): ${list(result.filesChanged)}`,
    `Workspace changes (observed by the bridge): ${list(result.observedChanges)}`,
    `Tests: ${list(result.tests, 6)}`,
    `Evidence: ${list(result.evidence, 6)}`,
  );
  if (result.warnings.length) lines.push(`Warnings: ${list(result.warnings, 6)}`);
  lines.push(
    `Workspace: ${result.worktreePath}${result.branch ? ` (branch ${result.branch})` : ""}. Sandbox: ${result.sandbox}.`,
    `Full details: bridge_orchestration_status {"runId": "${result.runId}"}. Verify the work before reporting it as done. This is an automated bridge message.`,
  );
  return lines.join("\n\n");
}

interface Observed {
  observedChanges: string[] | null;
  warnings: string[];
}

export interface OrchestratorOptions {
  /** Grace period before a finished background round is posted to the mailbox. */
  deliveryDelayMs?: number;
  /** How often a waiter polls a run owned by another process. */
  pollMs?: number;
}

export class Orchestrator {
  private readonly active = new Map<string, Promise<void>>();
  private readonly orphans = new Map<string, NodeJS.Timeout>();
  private selfStarted: string | null | undefined;
  private closed = false;

  constructor(
    private readonly store: BridgeStore,
    private readonly runner: CodexRunner = new CodexCliRunner(),
    private readonly workspace: WorkspaceManager = new GitWorkspaceManager(),
    private readonly options: OrchestratorOptions = {},
  ) {}

  private async ownerStart(): Promise<string | null> {
    if (this.selfStarted === undefined) this.selfStarted = await processStartTime(process.pid);
    return this.selfStarted;
  }

  async start(input: StartOrchestrationInput): Promise<OrchestrationResult> {
    if (!input.coordinatorAgent.trim()) throw new Error("coordinatorAgent is required");
    if (!input.task.trim()) throw new Error("task is required");
    if (!input.threadId.trim()) throw new Error("threadId is required");
    if (input.maxRounds < 1 || input.maxRounds > 12) {
      throw new Error("maxRounds must be between 1 and 12");
    }

    const runId = randomUUID();
    const sandbox = input.sandbox ?? "workspace-write";
    const prepared = await this.workspace.prepare({
      projectPath: input.projectPath,
      useWorktree: input.useWorktree,
      runId,
      threadId: input.threadId,
      includeUncommitted: input.includeUncommitted,
    });
    this.store.createRun({
      id: runId,
      coordinatorAgent: input.coordinatorAgent,
      projectPath: input.projectPath,
      worktreePath: prepared.path,
      threadId: input.threadId,
      task: input.task,
      status: "created",
      maxRounds: input.maxRounds,
      sandboxMode: sandbox,
      baseCommit: prepared.baseCommit,
      branch: prepared.branch,
      ownerPid: process.pid,
      ownerStarted: await this.ownerStart(),
    });
    this.store.appendRunEvent(runId, "created", {
      coordinatorAgent: input.coordinatorAgent,
      projectPath: input.projectPath,
      worktreePath: prepared.path,
      branch: prepared.branch,
      baseCommit: prepared.baseCommit,
      sandbox,
      threadId: input.threadId,
      uncommittedChanges: prepared.uncommitted.length,
      includedUncommitted: prepared.includedUncommitted,
      warnings: prepared.warnings,
    });
    const baseline = sandbox === "read-only" ? await this.workspace.changes(prepared.path) : null;
    await this.launch(runId, basePrompt(input.task, { sandbox, warnings: prepared.warnings }), null, baseline);
    return this.awaitResult(runId, input.waitMs ?? DEFAULT_WAIT_MS);
  }

  async continueWithFable(runId: string, answer: string, waitMs = DEFAULT_WAIT_MS): Promise<OrchestrationResult> {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`Unknown orchestration run: ${runId}`);
    if (run.status !== "waiting_for_fable") {
      throw new Error(`Run ${runId} is not waiting for Fable (status: ${run.status})`);
    }
    if (!run.codexSessionId) throw new Error(`Run ${runId} has no Codex session ID`);
    if (run.round >= run.maxRounds) {
      const blocked = this.store.updateRun(runId, {
        status: "blocked",
        latestResponse: { summary: "Fable/Codex round limit reached" },
      });
      this.store.appendRunEvent(runId, "round_limit", { round: run.round, maxRounds: run.maxRounds });
      this.store.claimRunDelivery(runId, blocked.round);
      return this.resultFromRun(blocked, { summary: "Fable/Codex round limit reached" });
    }

    this.store.appendRunEvent(runId, "fable_answer", { round: run.round + 1, answer });
    const baseline = run.sandboxMode === "read-only" ? await this.workspace.changes(run.worktreePath) : null;
    await this.launch(runId, continuationPrompt(answer), run.codexSessionId, baseline);
    return this.awaitResult(runId, waitMs);
  }

  /** Bounded wait for a run started by this or any other bridge process. */
  async wait(runId: string, waitMs = DEFAULT_WAIT_MS): Promise<OrchestrationResult> {
    if (!this.store.getRun(runId)) throw new Error(`Unknown orchestration run: ${runId}`);
    return this.awaitResult(runId, waitMs);
  }

  status(runId: string) {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`Unknown orchestration run: ${runId}`);
    return { run, events: this.store.runEvents(runId) };
  }

  private async launch(runId: string, prompt: string, sessionId: string | null, baseline: string[] | null): Promise<void> {
    const run = this.store.getRun(runId) as OrchestrationRun;
    this.store.updateRun(runId, {
      status: "running_codex",
      round: run.round + 1,
      ownerPid: process.pid,
      ownerStarted: await this.ownerStart(),
      childPid: null,
      childStarted: null,
      turnFiles: null,
      turnStartedAt: new Date().toISOString(),
    });
    const settled = this.runner
      .run(
        { cwd: run.worktreePath, prompt, sessionId, sandbox: run.sandboxMode },
        {
          onSpawn: (info) =>
            this.store.updateRun(runId, { childPid: info.pid, childStarted: info.started, turnFiles: info.files }),
          onSession: (id) => this.store.updateRun(runId, { codexSessionId: id }),
        },
      )
      .then(
        async (outcome) => this.applyTurn(runId, outcome.sessionId, outcome.response, await this.observe(runId, baseline)),
        (error: unknown) => {
          this.fail(runId, error);
        },
      )
      .then(() => this.scheduleDelivery(runId))
      .catch(() => {
        // The run state is durable; reconciliation retries delivery.
      })
      .finally(() => this.active.delete(runId));
    this.active.set(runId, settled);
  }

  private async observe(runId: string, baseline: string[] | null): Promise<Observed> {
    const run = this.store.getRun(runId) as OrchestrationRun;
    const observedChanges = await this.workspace.changes(run.worktreePath);
    const warnings: string[] = [];
    if (
      run.sandboxMode === "read-only" &&
      baseline !== null &&
      observedChanges !== null &&
      JSON.stringify(observedChanges) !== JSON.stringify(baseline)
    ) {
      warnings.push("The workspace changed during a read-only run. Inspect it before relying on the review.");
    }
    return { observedChanges, warnings };
  }

  private applyTurn(runId: string, sessionId: string, response: CodexTurnResponse, observed: Observed): void {
    const status: OrchestrationStatus = response.status === "needs_fable" ? "waiting_for_fable" : response.status;
    const run = this.store.updateRun(runId, {
      status,
      codexSessionId: sessionId,
      latestResponse: { ...response, bridge: observed } as unknown as Record<string, unknown>,
      childPid: null,
      childStarted: null,
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
      observedChanges: observed.observedChanges,
      warnings: observed.warnings,
    });
  }

  private fail(runId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.store.updateRun(runId, {
      status: "failed",
      latestResponse: { summary: message },
      childPid: null,
      childStarted: null,
    });
    this.store.appendRunEvent(runId, "failed", { message });
  }

  private scheduleDelivery(runId: string): void {
    if (this.closed) return; // Another process's reconciliation delivers it.
    setTimeout(() => {
      try {
        this.deliver(runId);
      } catch {
        // Reconciliation retries.
      }
    }, this.options.deliveryDelayMs ?? 1500).unref();
  }

  /** Post a finished round to the coordinator's mailbox, exactly once. */
  deliver(runId: string): boolean {
    const run = this.store.getRun(runId);
    if (!run || run.status === "running_codex") return false;
    if (!this.store.claimRunDelivery(runId, run.round)) return false;
    const result = this.resultFromRun(run);
    this.store.send({
      fromAgent: BRIDGE_AGENT,
      toAgent: run.coordinatorAgent,
      threadId: run.threadId,
      body: runResultMessage(result, run.threadId),
      idempotencyKey: `run:${runId}:round:${run.round}`,
    });
    return true;
  }

  private async awaitResult(runId: string, waitMs: number): Promise<OrchestrationResult> {
    const deadline = Date.now() + Math.min(Math.max(waitMs, 0), MAX_WAIT_MS);
    const local = this.active.get(runId);
    if (local && deadline > Date.now()) {
      const timer = new AbortController();
      await Promise.race([local, sleep(deadline - Date.now(), undefined, { signal: timer.signal }).catch(() => {})]);
      timer.abort();
    }
    const pollMs = this.options.pollMs ?? 500;
    while (Date.now() < deadline && this.store.getRun(runId)?.status === "running_codex") {
      await sleep(Math.min(pollMs, Math.max(deadline - Date.now(), 1)));
    }
    const run = this.store.getRun(runId) as OrchestrationRun;
    if (run.status === "running_codex") {
      return this.resultFromRun(run, {
        summary: "Codex is still working.",
        next: `The result will be posted to ${run.coordinatorAgent}'s mailbox from "bridge" on thread ${JSON.stringify(run.threadId)} (a bound coordinator is pinged). You can also call bridge_orchestration_wait with this runId. Do not start a duplicate run.`,
      });
    }
    const claimed = this.store.claimRunDelivery(runId, run.round);
    return this.resultFromRun(run, claimed ? {} : { next: "This result was also posted to the coordinator's mailbox." });
  }

  /**
   * Recover runs whose owning bridge process exited: adopt them, keep watching
   * a Codex process that is still working, finish from its files once it
   * exits, and post any undelivered results. Safe to run from every process.
   */
  async reconcile(now = Date.now()): Promise<{ adopted: number; delivered: number }> {
    let adopted = 0;
    let delivered = 0;
    for (const run of this.store.runsWithStatus("running_codex")) {
      if (run.ownerPid === null || this.active.has(run.id) || this.orphans.has(run.id)) continue;
      if (run.ownerPid !== process.pid && (await isProcessAlive(run.ownerPid, run.ownerStarted))) continue;
      if (!this.store.adoptRun(run.id, run.ownerPid, process.pid, await this.ownerStart())) continue;
      adopted += 1;
      this.store.appendRunEvent(run.id, "adopted", { previousOwnerPid: run.ownerPid, ownerPid: process.pid });
      this.watchOrphan(run.id);
    }
    for (const run of this.store.undeliveredRuns(new Date(now - 5_000).toISOString())) {
      if (!this.active.has(run.id) && this.deliver(run.id)) delivered += 1;
    }
    return { adopted, delivered };
  }

  private watchOrphan(runId: string): void {
    const check = async () => {
      const run = this.store.getRun(runId);
      if (!run || run.status !== "running_codex" || run.ownerPid !== process.pid) {
        this.stopWatching(runId);
        return;
      }
      if (await isProcessAlive(run.childPid, run.childStarted)) {
        const started = run.turnStartedAt ? Date.parse(run.turnStartedAt) : Date.now();
        if (Date.now() - started < this.runner.turnTimeoutMs) return;
        if (run.childPid) terminateProcessTree(run.childPid);
      }
      this.stopWatching(runId);
      await this.finishOrphan(run);
    };
    const timer = setInterval(() => void check().catch(() => {}), 2000);
    timer.unref();
    this.orphans.set(runId, timer);
    void check().catch(() => {});
  }

  private stopWatching(runId: string): void {
    const timer = this.orphans.get(runId);
    if (timer) clearInterval(timer);
    this.orphans.delete(runId);
  }

  private async finishOrphan(run: OrchestrationRun): Promise<void> {
    try {
      if (!run.turnFiles || !this.runner.recover) throw new Error("no turn output was recorded");
      const outcome = this.runner.recover(run.turnFiles, run.codexSessionId);
      const observed = await this.observe(run.id, null);
      observed.warnings.push("Recovered after the bridge process that started this turn exited.");
      this.applyTurn(run.id, outcome.sessionId, outcome.response, observed);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.fail(run.id, new Error(`Codex turn was interrupted when its bridge process exited (${reason}). The workspace is preserved at ${run.worktreePath}.`));
    }
    this.deliver(run.id);
  }

  /** Stop background timers. Detached Codex turns keep running; another process adopts them. */
  close(): void {
    this.closed = true;
    for (const runId of [...this.orphans.keys()]) this.stopWatching(runId);
  }

  private resultFromRun(
    run: OrchestrationRun,
    overrides: { summary?: string; next?: string } = {},
  ): OrchestrationResult {
    const latest = run.latestResponse as
      | (Partial<CodexTurnResponse> & { bridge?: Partial<Observed> })
      | null;
    const created = this.store.runEvents(run.id).find((event) => event.type === "created");
    const setupWarnings = Array.isArray(created?.payload.warnings) ? (created.payload.warnings as string[]) : [];
    const running = run.status === "running_codex";
    return {
      runId: run.id,
      status: run.status,
      round: run.round,
      maxRounds: run.maxRounds,
      codexSessionId: run.codexSessionId,
      worktreePath: run.worktreePath,
      branch: run.branch,
      baseCommit: run.baseCommit,
      sandbox: run.sandboxMode,
      summary: overrides.summary ?? latest?.summary ?? "",
      question: running ? undefined : latest?.question,
      evidence: running ? [] : latest?.evidence ?? [],
      filesChanged: running ? [] : latest?.filesChanged ?? [],
      tests: running ? [] : latest?.tests ?? [],
      suggestedChips: running ? [] : latest?.suggestedChips ?? [],
      observedChanges: running ? null : latest?.bridge?.observedChanges ?? null,
      warnings: [...setupWarnings, ...(running ? [] : latest?.bridge?.warnings ?? [])],
      ...(overrides.next ? { next: overrides.next } : {}),
    };
  }
}
