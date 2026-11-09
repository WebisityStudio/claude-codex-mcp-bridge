import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
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
import type { ClaudePermissionMode, WorkerKind } from "./worker-policy.js";

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
  /** The model the caller chose, or null for the app's default. */
  model?: string | null;
  /** The reasoning effort the caller chose, or null for the model's default. */
  effort?: string | null;
  /** Claude workers: the permission mode for this turn. */
  permissionMode?: ClaudePermissionMode | null;
  /** A short name for the chat, shown in the app's own list. */
  title?: string | null;
}

export interface TurnHooks {
  onSpawn?(info: { pid: number | null; started: string | null; files: TurnFiles | null }): void;
  onSession?(sessionId: string): void;
}

export interface TurnOutcome {
  sessionId: string;
  response: CodexTurnResponse;
  /** What the runner itself noticed, such as tool calls the permission mode refused. */
  warnings?: string[];
}

export interface CodexRunner {
  /** Longest a single turn may run before it is stopped. */
  readonly turnTimeoutMs: number;
  /** True when the app lists chats this runner starts, so `codex://threads/<id>` opens them. */
  readonly listedInApp?: boolean;
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
  /** Aborted when the caller cancels or disconnects; the result then goes to the mailbox. */
  signal?: AbortSignal;
  /** Which app runs the worker chat. Defaults to Codex. */
  worker?: WorkerKind;
  /** The caller's choices, already checked against the owner's policy. */
  model?: string;
  effort?: string;
  /** Claude workers: plan and manual cannot change files; acceptEdits and auto can. */
  permissionMode?: ClaudePermissionMode;
  /** Claude workers: open the finished chat in the Claude desktop app. */
  showInDesktop?: boolean;
  /** A short name for the chat in the app's own list. */
  title?: string;
  /** Notes from the policy check to carry in the result. */
  warnings?: string[];
}

/** What a run was started with; kept in its first event so later rounds use the same. */
interface WorkerSettings {
  worker: WorkerKind;
  model: string | null;
  effort: string | null;
  permissionMode: ClaudePermissionMode | null;
  showInDesktop: boolean;
  title: string | null;
}

/** The outcome of opening a finished Claude chat in the desktop app. */
export interface DesktopHandoffResult {
  shown: boolean;
  detail: string;
  /** What to run in a terminal, in the chat's folder, to open it by hand. */
  manualCommand: string;
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
  /** Which app ran the worker chat. */
  worker: WorkerKind;
  /** The worker chat's own ID in that app (the same value as codexSessionId, whichever app ran it). */
  sessionId: string | null;
  /** The model and effort the caller chose; absent means the app's defaults. */
  model?: string;
  effort?: string;
  /** Claude workers: the permission mode the chat ran in. */
  permissionMode?: ClaudePermissionMode;
  /** Codex workers started through app-server: a link that opens the chat in the Codex app. */
  appLink?: string;
  /** Claude workers: whether the finished chat was opened in the desktop app. */
  desktop?: DesktopHandoffResult;
}

/** Stay below the ~5 minute limit common MCP hosts apply to one tool call. */
export const DEFAULT_WAIT_MS = 240_000;
export const MAX_WAIT_MS = 285_000;

/** The envelope every worker turn answers with, whichever app runs it. */
export const CODEX_OUTPUT_SCHEMA = {
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
  /** Test seam: which bundled paths exist. Defaults to the file system. */
  exists?: (path: string) => boolean;
}

/**
 * Where the macOS ChatGPT app has shipped its Codex CLI, newest layout first.
 * Using the app's own copy keeps worker chats in the format the app reads.
 */
export const BUNDLED_CODEX_PATHS = [
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
  "/Applications/ChatGPT.app/Contents/Resources/codex",
] as const;

export function resolveCodexBinary(input: ResolveCodexBinaryInput = {}): string {
  if (input.configuredBinary?.trim()) return input.configuredBinary;
  if ((input.platform ?? process.platform) !== "darwin") return "codex";
  const exists = input.exists ?? existsSync;
  return BUNDLED_CODEX_PATHS.find((path) => exists(path)) ?? "codex";
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
  model?: string | null;
  effort?: string | null;
}): string[] {
  const config = [
    ...(input.extraConfig ?? []).flatMap((entry) => ["-c", entry]),
    ...pinnedCodexConfig(input),
  ];
  const output = ["--json", "-o", input.outputPath, "--output-schema", input.schemaPath];
  return input.sessionId
    ? ["exec", "resume", ...config, ...output, input.sessionId, "-"]
    : ["exec", "--sandbox", input.sandbox, ...config, ...output, "-"];
}

/**
 * `-c` overrides every Codex worker turn carries, whichever way it is started.
 * The caller's model and effort come first; the safety values come last so
 * nothing earlier on the command line can replace them.
 */
export function pinnedCodexConfig(input: { sandbox: SandboxMode; model?: string | null; effort?: string | null }): string[] {
  const config: string[] = [];
  if (input.model) config.push("-c", `model=${JSON.stringify(input.model)}`);
  if (input.effort) config.push("-c", `model_reasoning_effort=${JSON.stringify(input.effort)}`);
  config.push("-c", 'approval_policy="never"', "-c", `sandbox_mode="${input.sandbox}"`);
  if (input.sandbox === "workspace-write") {
    config.push("-c", "sandbox_workspace_write.network_access=false");
  }
  return config;
}

export function validateResponse(value: unknown): CodexTurnResponse {
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

export function readTail(path: string, bytes: number): string {
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

export interface DetachedCommand {
  command: string;
  args: string[];
}

/**
 * Runs one worker turn as a detached process that writes to files. If the MCP
 * process exits mid-turn, the worker keeps going and any bridge process can
 * finish the run from those files. Subclasses say which process to start and
 * how to read its result.
 */
export abstract class DetachedTurnRunner implements CodexRunner {
  protected readonly dataDir: string;
  readonly turnTimeoutMs: number;
  /** Named in errors, e.g. "Codex" or "Claude". */
  protected readonly label: string = "Codex";

  constructor(options: { dataDir?: string; timeoutMs?: number } = {}) {
    this.dataDir = options.dataDir ?? runsDir();
    const configuredMinutes = Number(process.env.BRIDGE_CODEX_TURN_TIMEOUT_MINUTES);
    this.turnTimeoutMs =
      options.timeoutMs ??
      (Number.isFinite(configuredMinutes) && configuredMinutes > 0 ? configuredMinutes * 60_000 : 20 * 60_000);
    ensurePrivateDirectory(this.dataDir);
  }

  /** The process for one turn. It reads the prompt on stdin; its stdout becomes the events file. */
  protected abstract command(request: CodexTurnRequest, files: TurnFiles, sessionId: string | null): DetachedCommand;

  /** Read a finished turn from its files. `exitCode` is null when another process is recovering it. */
  protected abstract collect(files: TurnFiles, knownSessionId: string | null, exitCode: number | null): TurnOutcome;

  /** A session ID chosen before a new worker starts, for workers that accept one. */
  protected newSessionId(): string | null {
    return null;
  }

  /** The session ID the worker has reported so far. */
  protected reportedSessionId(files: TurnFiles): string | null {
    return readSessionId(files.eventsPath);
  }

  async run(request: CodexTurnRequest, hooks: TurnHooks = {}): Promise<TurnOutcome> {
    const id = randomUUID();
    const files: TurnFiles = {
      outputPath: join(this.dataDir, `${id}.json`),
      eventsPath: join(this.dataDir, `${id}.events.jsonl`),
      stderrPath: join(this.dataDir, `${id}.stderr.log`),
    };
    const sessionId = request.sessionId ?? this.newSessionId();
    const { command, args } = this.command(request, files, sessionId);
    const eventsFd = openSync(files.eventsPath, "w", 0o600);
    const stderrFd = openSync(files.stderrPath, "w", 0o600);
    let child;
    try {
      child = spawn(command, args, {
        cwd: request.cwd,
        env: buildSafeEnvironment(),
        stdio: ["pipe", eventsFd, stderrFd],
        detached: process.platform !== "win32",
      });
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
    const report = (seen: string | null) => {
      if (seen && seen !== reported) {
        reported = seen;
        hooks.onSession?.(seen);
      }
    };
    report(sessionId);
    const watch = setInterval(() => report(this.reportedSessionId(files)), 500);
    watch.unref();
    let deadline: NodeJS.Timeout | undefined;
    try {
      const code = await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => {
            if (child.pid) terminateProcessTree(child.pid);
            reject(new Error(`${this.label} turn timed out after ${Math.round(this.turnTimeoutMs / 60_000)} minutes`));
          }, this.turnTimeoutMs);
        }),
      ]);
      report(this.reportedSessionId(files)); // A fast turn can finish between two looks.
      return this.collect(files, sessionId, code);
    } finally {
      clearInterval(watch);
      clearTimeout(deadline);
    }
  }

  recover(files: TurnFiles, knownSessionId: string | null): TurnOutcome {
    return this.collect(files, knownSessionId, null);
  }
}

/** Write the envelope schema every Codex worker turn must answer with; returns its path. */
export function writeTurnSchema(dataDir: string): string {
  const path = join(dataDir, "codex-turn.schema.json");
  writeFileSync(path, `${JSON.stringify(CODEX_OUTPUT_SCHEMA, null, 2)}\n`, { mode: 0o600 });
  return path;
}

/** Read a Codex turn's result: the session from the event stream, the envelope from the output file. */
export function collectCodexTurn(files: TurnFiles, knownSessionId: string | null, exitCode: number | null): TurnOutcome {
  if (exitCode !== null && exitCode !== 0) {
    throw new Error(`Codex exited ${exitCode}: ${readTail(files.stderrPath, 4000) || "no diagnostic output"}`);
  }
  const sessionId = readSessionId(files.eventsPath) ?? knownSessionId;
  if (!sessionId) throw new Error("Codex did not report a session ID");
  if (!existsSync(files.outputPath)) throw new Error("Codex did not write its final response");
  return { sessionId, response: validateResponse(JSON.parse(readFileSync(files.outputPath, "utf8"))) };
}

/**
 * Codex turns through `codex exec`. These sessions are saved but the Codex
 * app does not list them; `CodexAppServerRunner` is the default for that
 * reason, and this runner remains as the fallback (BRIDGE_CODEX_RUNNER=exec).
 */
export class CodexCliRunner extends DetachedTurnRunner {
  private readonly binary: string;
  private readonly schemaPath: string;
  private readonly extraConfig: string[];

  constructor(options: { binary?: string; dataDir?: string; timeoutMs?: number; extraConfig?: string[] } = {}) {
    super(options);
    this.binary = resolveCodexBinary({ configuredBinary: options.binary ?? process.env.CODEX_BIN });
    this.extraConfig = options.extraConfig ?? parseExtraCodexConfig(process.env.BRIDGE_CODEX_CONFIG);
    this.schemaPath = writeTurnSchema(this.dataDir);
  }

  protected command(request: CodexTurnRequest, files: TurnFiles): DetachedCommand {
    return {
      command: this.binary,
      args: buildCodexArgs({
        sessionId: request.sessionId,
        sandbox: request.sandbox,
        outputPath: files.outputPath,
        schemaPath: this.schemaPath,
        extraConfig: this.extraConfig,
        model: request.model,
        effort: request.effort,
      }),
    };
  }

  protected collect(files: TurnFiles, knownSessionId: string | null, exitCode: number | null): TurnOutcome {
    return collectCodexTurn(files, knownSessionId, exitCode);
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

/** Git preparation runs before the worker sandbox: never run repository helpers. */
async function runGit(
  cwd: string,
  args: string[],
  options: { input?: string; trim?: boolean } = {},
): Promise<string> {
  const config = [
    "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
    "-c", "core.fsmonitor=false",
  ];
  // Config discovery does not run hooks or filters. Disable all configured
  // clean/smudge/process drivers, including ones selected by .gitattributes.
  const names = await runProcess("git", ["-C", cwd, ...config, "config", "--null", "--name-only", "--list"], { trim: false });
  for (const key of new Set(names.split("\0"))) {
    if (/^filter\..+\.(clean|smudge|process|required)$/.test(key)) {
      config.push("-c", `${key}=${key.endsWith(".required") ? "false" : ""}`);
    }
  }
  const command = args[0] === "diff" ? ["diff", "--no-ext-diff", "--no-textconv", ...args.slice(1)] : args;
  return runProcess("git", ["-C", cwd, ...config, ...command], options);
}

/** Reject links and special files rather than materializing host data in a worktree. */
function untrackedPath(root: string, file: string, createParents = false): string {
  const parts = file.split("/");
  const target = join(root, file);
  const offset = relative(root, target);
  if (isAbsolute(file) || !offset || isAbsolute(offset) || offset === ".." || offset.startsWith(`..${sep}`) ||
      parts.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git") ||
      (process.platform === "win32" && /[\\:]/.test(file))) {
    throw new Error(`Unsafe untracked path: ${JSON.stringify(file)}`);
  }
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    if (createParents) {
      try { mkdirSync(parent); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const stat = lstatSync(parent);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe untracked parent: ${JSON.stringify(file)}`);
  }
  return target;
}

function copyUntrackedFile(sourceRoot: string, destinationRoot: string, file: string): void {
  const source = untrackedPath(sourceRoot, file);
  const sourceInfo = lstatSync(source);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
    throw new Error(`Untracked symlinks and special files are not copied: ${JSON.stringify(file)}`);
  }
  const target = untrackedPath(destinationRoot, file, true);
  // No-follow prevents a replaced leaf from becoming a symlink read. Exclusive
  // creation also refuses to overwrite a tracked file or follow a destination link.
  const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let output: number | undefined;
  try {
    const opened = fstatSync(input);
    if (!opened.isFile() || opened.dev !== sourceInfo.dev || opened.ino !== sourceInfo.ino) {
      throw new Error(`Untracked file changed while copying: ${JSON.stringify(file)}`);
    }
    output = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, opened.mode & 0o777);
    const buffer = Buffer.alloc(64 * 1024);
    let remaining = opened.size;
    while (remaining > 0) {
      const count = readSync(input, buffer, 0, Math.min(buffer.length, remaining), null);
      if (count === 0) throw new Error(`Untracked file changed while copying: ${JSON.stringify(file)}`);
      let written = 0;
      while (written < count) written += writeSync(output, buffer, written, count - written);
      remaining -= count;
    }
  } finally {
    if (output !== undefined) closeSync(output);
    closeSync(input);
  }
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
    const folder = statSync(input.projectPath, { throwIfNoEntry: false });
    if (!folder?.isDirectory()) throw new Error(`projectPath is not a folder: ${input.projectPath}`);
    const top = await runGit(input.projectPath, ["rev-parse", "--show-toplevel"]).catch(() => null);
    if (top === null) {
      // A worker can still be started in a plain folder; only the worktree and the change report need git.
      if (input.useWorktree) {
        throw new Error(`${input.projectPath} is not a git repository, so it cannot have an isolated worktree. Pass useWorktree: false to work in the folder itself.`);
      }
      return {
        path: input.projectPath,
        branch: null,
        baseCommit: null,
        uncommitted: [],
        includedUncommitted: true,
        warnings: [`${input.projectPath} is not a git repository, so the bridge cannot report which files changed.`],
      };
    }
    const baseCommit = await runGit(top, ["rev-parse", "--verify", "HEAD"]).catch(() => null);
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
      await runGit(top, ["worktree", "add", "-b", branch, worktreePath, baseCommit]);
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
          warnings.push(`Could not copy all of the main checkout's uncommitted changes (${reason}). The worktree is based on commit ${baseCommit.slice(0, 12)} and may contain partially copied changes; inspect it before continuing.`);
        }
      } else {
        warnings.push(
          `The main checkout has ${uncommitted.length} uncommitted change(s) that are not in this worktree; it starts from commit ${baseCommit.slice(0, 12)}. Pass includeUncommitted: true to copy them in.`,
        );
      }
    }
    // Keep the caller's subdirectory when projectPath points inside the repository.
    // Git reports it directly, so symlinks, case and Windows short names cannot confuse it.
    const prefix = (await runGit(input.projectPath, ["rev-parse", "--show-prefix"])).replace(/[\\/]+$/, "");
    const path = prefix ? join(worktreePath, prefix) : worktreePath;
    return { path, branch, baseCommit, uncommitted, includedUncommitted, warnings };
  }

  private async copyUncommitted(top: string, worktreePath: string): Promise<void> {
    const patch = await runGit(top, ["diff", "--binary", "HEAD"], { trim: false });
    if (patch.trim()) {
      await runGit(worktreePath, ["apply", "--binary", "--whitespace=nowarn", "-"], { input: patch });
    }
    const untracked = await runGit(top, ["ls-files", "--others", "--exclude-standard", "-z"], {
      trim: false,
    });
    const sourceRoot = realpathSync(top);
    const destinationRoot = realpathSync(worktreePath);
    for (const file of untracked.split("\0").filter(Boolean)) {
      if (file.startsWith(LEGACY_WORKTREE_DIR)) continue;
      copyUntrackedFile(sourceRoot, destinationRoot, file);
    }
  }

  async changes(path: string): Promise<string[] | null> {
    try {
      const output = await runGit(path, ["status", "--porcelain=v1", "--untracked-files=all"], {
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

const WORKER_LABEL: Record<WorkerKind, string> = { codex: "Codex", claude: "Claude" };

function basePrompt(task: string, context: { sandbox: SandboxMode; warnings: string[]; worker?: WorkerKind }): string {
  const claude = context.worker === "claude";
  const workspace =
    context.sandbox === "read-only"
      ? claude
        ? "- This chat cannot change files. Inspect files and run read-only commands; do not try to edit anything."
        : "- Your sandbox is read-only. Inspect files and run read-only commands; do not try to edit anything."
      : claude
        ? "- Work only inside the supplied workspace."
        : "- Work only inside the supplied workspace. Network access is disabled.";
  const notes = context.warnings.length
    ? `\n\nWORKSPACE NOTES:\n${context.warnings.map((warning) => `- ${warning}`).join("\n")}`
    : "";
  const role = claude
    ? "You are a Claude Code worker started by another agent session through claude-codex-bridge."
    : "You are a Codex worker coordinated by a Claude session through claude-codex-bridge.";
  return `${role}\n\nTASK:\n${task}${notes}\n\nSAFETY BOUNDARY:\n${workspace}\n- Do not commit, push, merge, deploy, publish, send external messages, change credentials/configuration, delete data, or perform production mutations.\n- If any such action is required, return status blocked and explain exactly what approval is needed.\n- Run relevant tests and report real evidence.\n- If a hard architecture/reasoning decision needs the coordinator, return needs_fable with one precise question. Do not guess.\n- You may suggest up to three independent child chips, but do not launch them yourself.\n- Return only the required JSON envelope.`;
}

function continuationPrompt(answer: string): string {
  return `The coordinating session answered your question:\n\n${answer}\n\nContinue the original task in the same workspace. Keep the same safety boundary. Run verification and return only the required JSON envelope. If another genuinely hard question remains, return needs_fable again.`;
}

function list(items: string[] | null | undefined, max = 12): string {
  if (!items || items.length === 0) return "none";
  const shown = items.slice(0, max).join("; ");
  return items.length > max ? `${shown}; and ${items.length - max} more` : shown;
}

/** The mailbox message a coordinator receives when a background run finishes a round. */
export function runResultMessage(result: OrchestrationResult, threadId: string): string {
  const who = WORKER_LABEL[result.worker ?? "codex"];
  const lines = [
    `${who} run ${result.runId} (thread ${JSON.stringify(threadId)}) finished round ${result.round} of ${result.maxRounds}: ${result.status}.`,
    `Summary: ${result.summary}`,
  ];
  if (result.status === "waiting_for_fable" && result.question) {
    lines.push(
      `${who} asks: ${result.question}`,
      `Answer with bridge_continue_run {"runId": "${result.runId}", "answer": "..."}.`,
    );
  }
  lines.push(
    `Files changed (reported by ${who}): ${list(result.filesChanged)}`,
    `Workspace changes (observed by the bridge): ${list(result.observedChanges)}`,
    `Tests: ${list(result.tests, 6)}`,
    `Evidence: ${list(result.evidence, 6)}`,
  );
  if (result.warnings.length) lines.push(`Warnings: ${list(result.warnings, 6)}`);
  const access = result.permissionMode ? `Permission mode: ${result.permissionMode}` : `Sandbox: ${result.sandbox}`;
  lines.push(`Workspace: ${result.worktreePath}${result.branch ? ` (branch ${result.branch})` : ""}. ${access}.`);
  if (result.appLink) lines.push(`The chat is in the Codex app's list; ${result.appLink} opens it.`);
  if (result.desktop) {
    lines.push(
      result.desktop.shown
        ? "The chat was opened in the Claude desktop app."
        : `The chat was not opened in the Claude desktop app (${result.desktop.detail}). In a terminal in the workspace: ${result.desktop.manualCommand}`,
    );
  }
  lines.push(
    `Full details: bridge_orchestration_status {"runId": "${result.runId}"}. Verify the work before reporting it as done. This is an automated bridge message.`,
  );
  return lines.join("\n\n");
}

interface Observed {
  observedChanges: string[] | null;
  warnings: string[];
  desktop?: DesktopHandoffResult;
}

export interface OrchestratorOptions {
  /** Grace period before a finished background round is posted to the mailbox. */
  deliveryDelayMs?: number;
  /** How often a waiter polls a run owned by another process. */
  pollMs?: number;
  /** Runs Claude worker chats. Without it, Claude workers are refused. */
  claudeRunner?: CodexRunner;
  /** Opens a finished Claude chat in the desktop app. Without it, the manual command is reported. */
  showInDesktop?: (chat: { cwd: string; sessionId: string }) => Promise<DesktopHandoffResult>;
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

    const worker = input.worker ?? "codex";
    this.runnerFor(worker); // Refuse a worker this bridge cannot run before anything is created.
    const runId = randomUUID();
    // Claude's plan and manual modes cannot change files, so the bridge watches them like a read-only sandbox.
    const readOnlyMode = worker === "claude" && (input.permissionMode === "plan" || input.permissionMode === "manual");
    const sandbox = input.sandbox ?? (readOnlyMode ? "read-only" : "workspace-write");
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
      warnings: [...prepared.warnings, ...(input.warnings ?? [])],
      worker,
      model: input.model ?? null,
      effort: input.effort ?? null,
      permissionMode: worker === "claude" ? input.permissionMode ?? "acceptEdits" : null,
      showInDesktop: worker === "claude" && input.showInDesktop === true,
      title: input.title ?? null,
    });
    const baseline = sandbox === "read-only" ? await this.workspace.changes(prepared.path) : null;
    await this.launch(runId, basePrompt(input.task, { sandbox, warnings: prepared.warnings, worker }), null, baseline);
    return this.awaitResult(runId, input.waitMs ?? DEFAULT_WAIT_MS, input.signal);
  }

  private runnerFor(worker: WorkerKind): CodexRunner {
    if (worker === "codex") return this.runner;
    if (!this.options.claudeRunner) throw new Error("This bridge process is not set up to run Claude workers.");
    return this.options.claudeRunner;
  }

  /** What the run was started with. Runs created before worker settings existed are Codex runs. */
  private settings(runId: string): WorkerSettings {
    const created = this.store.runEvents(runId).find((event) => event.type === "created")?.payload ?? {};
    const text = (value: unknown) => (typeof value === "string" && value ? value : null);
    return {
      worker: created.worker === "claude" ? "claude" : "codex",
      model: text(created.model),
      effort: text(created.effort),
      permissionMode: text(created.permissionMode) as ClaudePermissionMode | null,
      showInDesktop: created.showInDesktop === true,
      title: text(created.title),
    };
  }

  async continueWithFable(
    runId: string,
    answer: string,
    waitMs = DEFAULT_WAIT_MS,
    signal?: AbortSignal,
  ): Promise<OrchestrationResult> {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`Unknown orchestration run: ${runId}`);
    if (run.status !== "waiting_for_fable") {
      throw new Error(`Run ${runId} is not waiting for Fable (status: ${run.status})`);
    }
    if (!run.codexSessionId) throw new Error(`Run ${runId} has no saved worker session`);
    if (run.round >= run.maxRounds) {
      const summary = `Round limit reached: the coordinator and ${WORKER_LABEL[this.settings(runId).worker]} have used all ${run.maxRounds} rounds.`;
      const blocked = this.store.updateRun(runId, { status: "blocked", latestResponse: { summary } });
      this.store.appendRunEvent(runId, "round_limit", { round: run.round, maxRounds: run.maxRounds });
      this.store.claimRunDelivery(runId, blocked.round);
      return this.resultFromRun(blocked, { summary });
    }

    this.store.appendRunEvent(runId, "fable_answer", { round: run.round + 1, answer });
    const baseline = run.sandboxMode === "read-only" ? await this.workspace.changes(run.worktreePath) : null;
    await this.launch(runId, continuationPrompt(answer), run.codexSessionId, baseline);
    return this.awaitResult(runId, waitMs, signal);
  }

  /** Bounded wait for a run started by this or any other bridge process. */
  async wait(runId: string, waitMs = DEFAULT_WAIT_MS, signal?: AbortSignal): Promise<OrchestrationResult> {
    if (!this.store.getRun(runId)) throw new Error(`Unknown orchestration run: ${runId}`);
    return this.awaitResult(runId, waitMs, signal);
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
    const settings = this.settings(runId);
    const settled = this.runnerFor(settings.worker)
      .run(
        {
          cwd: run.worktreePath,
          prompt,
          sessionId,
          sandbox: run.sandboxMode,
          model: settings.model,
          effort: settings.effort,
          permissionMode: settings.permissionMode,
          title: settings.title,
        },
        {
          onSpawn: (info) =>
            this.store.updateRun(runId, { childPid: info.pid, childStarted: info.started, turnFiles: info.files }),
          onSession: (id) => this.store.updateRun(runId, { codexSessionId: id }),
        },
      )
      .then(
        (outcome) => this.settle(runId, outcome, baseline),
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

  /** Record a finished turn: what the workspace looks like, what the runner noticed, and the desktop hand-off. */
  private async settle(runId: string, outcome: TurnOutcome, baseline: string[] | null, note?: string): Promise<void> {
    const observed = await this.observe(runId, baseline);
    observed.warnings.push(...(outcome.warnings ?? []));
    if (note) observed.warnings.push(note);
    const settings = this.settings(runId);
    // A chat that is still waiting for an answer stays with the bridge; only a finished one is handed over.
    if (settings.worker === "claude" && settings.showInDesktop && outcome.response.status !== "needs_fable") {
      observed.desktop = await this.handOff(runId, outcome.sessionId);
    }
    this.applyTurn(runId, outcome.sessionId, outcome.response, observed);
  }

  private async handOff(runId: string, sessionId: string): Promise<DesktopHandoffResult> {
    const run = this.store.getRun(runId) as OrchestrationRun;
    const manualCommand = `claude --desktop --resume ${sessionId}`;
    if (!this.options.showInDesktop) {
      return { shown: false, detail: "This bridge process cannot open chats in the Claude desktop app.", manualCommand };
    }
    try {
      return await this.options.showInDesktop({ cwd: run.worktreePath, sessionId });
    } catch (error) {
      return { shown: false, detail: error instanceof Error ? error.message : String(error), manualCommand };
    }
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
      ...(observed.desktop ? { desktop: observed.desktop } : {}),
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

  private async awaitResult(runId: string, waitMs: number, signal?: AbortSignal): Promise<OrchestrationResult> {
    const deadline = Date.now() + Math.min(Math.max(waitMs, 0), MAX_WAIT_MS);
    const local = this.active.get(runId);
    if (local && deadline > Date.now() && !signal?.aborted) {
      const timer = new AbortController();
      const stop = () => timer.abort();
      signal?.addEventListener("abort", stop, { once: true });
      try {
        await Promise.race([local, sleep(deadline - Date.now(), undefined, { signal: timer.signal }).catch(() => {})]);
      } finally {
        timer.abort();
        signal?.removeEventListener("abort", stop);
      }
    }
    const pollMs = this.options.pollMs ?? 500;
    while (!signal?.aborted && Date.now() < deadline && this.store.getRun(runId)?.status === "running_codex") {
      await sleep(Math.min(pollMs, Math.max(deadline - Date.now(), 1)), undefined, { signal }).catch(() => {});
    }
    const run = this.store.getRun(runId) as OrchestrationRun;
    if (run.status === "running_codex") {
      return this.resultFromRun(run, {
        summary: "Codex is still working.",
        next: `The result will be posted to ${run.coordinatorAgent}'s mailbox from "bridge" on thread ${JSON.stringify(run.threadId)} (a bound coordinator is pinged). You can also call bridge_orchestration_wait with this runId. Do not start a duplicate run.`,
      });
    }
    if (signal?.aborted) {
      // Nobody receives this return value. Leave the round unclaimed so the
      // result is posted to the coordinator's mailbox instead of vanishing.
      return this.resultFromRun(run, {
        next: `This call was cancelled, so the result is posted to ${run.coordinatorAgent}'s mailbox from "bridge".`,
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
    const worker = this.settings(run.id).worker;
    try {
      const runner = this.runnerFor(worker);
      if (!run.turnFiles || !runner.recover) throw new Error("no turn output was recorded");
      const outcome = runner.recover(run.turnFiles, run.codexSessionId);
      await this.settle(run.id, outcome, null, "Recovered after the bridge process that started this turn exited.");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.fail(run.id, new Error(`${WORKER_LABEL[worker]} turn was interrupted when its bridge process exited (${reason}). The workspace is preserved at ${run.worktreePath}.`));
    }
    this.deliver(run.id);
  }

  /** Stop background timers. Detached worker turns keep running; another process adopts them. */
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
    const settings = this.settings(run.id);
    const listed = settings.worker === "codex" && this.runner.listedInApp === true && run.codexSessionId !== null;
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
      worker: settings.worker,
      sessionId: run.codexSessionId,
      ...(settings.model ? { model: settings.model } : {}),
      ...(settings.effort ? { effort: settings.effort } : {}),
      ...(settings.permissionMode ? { permissionMode: settings.permissionMode } : {}),
      ...(listed ? { appLink: `codex://threads/${run.codexSessionId}` } : {}),
      ...(!running && latest?.bridge?.desktop ? { desktop: latest.bridge.desktop as DesktopHandoffResult } : {}),
    };
  }
}
