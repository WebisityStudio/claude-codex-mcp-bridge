import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

import type { SandboxMode } from "./bridge-store.js";
import { dataDir } from "./paths.js";

/**
 * The owner's ceiling for worker chats that agents start through the bridge.
 *
 * An agent picks the folder, model, reasoning effort and permissions of the
 * chat it starts, but the bridge cannot see how much that agent itself is
 * allowed to do. Both apps cap a new chat at its parent's level; this file is
 * the bridge's equivalent, set by the owner in `policy.json` and never by a
 * tool call. Requests above the ceiling are refused with the limit named.
 */

export type WorkerKind = "codex" | "claude";

/** Lowest to highest. A model may not offer every level. */
export const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Least to most autonomy. Bypass permissions is never offered to workers. */
export const CLAUDE_PERMISSION_MODES = ["plan", "manual", "acceptEdits", "auto"] as const;
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];

/** Least to most access. Full access is never offered to workers. */
export const WORKER_SANDBOX_MODES = ["read-only", "workspace-write"] as const satisfies readonly SandboxMode[];

export const DESKTOP_HANDOFF_MODES = ["never", "on-request", "always"] as const;
export type DesktopHandoffMode = (typeof DESKTOP_HANDOFF_MODES)[number];

export interface WorkerPolicy {
  /** Worker chats (Codex and Claude together) that may be started per rolling hour. */
  maxStartsPerHour: number;
  /** Folders a worker may be started in. Empty means any folder. */
  allowedRoots: string[];
  codex: {
    /** Models an agent may ask for. Empty means any model the app offers. */
    allowedModels: string[];
    maxEffort: EffortLevel;
    maxSandbox: SandboxMode;
  };
  claude: {
    allowedModels: string[];
    maxEffort: EffortLevel;
    maxPermissionMode: ClaudePermissionMode;
    /** Whether a finished Claude worker chat is opened in the desktop app. */
    showInDesktop: DesktopHandoffMode;
  };
}

export const DEFAULT_POLICY: WorkerPolicy = {
  maxStartsPerHour: 12,
  allowedRoots: [],
  codex: { allowedModels: [], maxEffort: "high", maxSandbox: "workspace-write" },
  claude: { allowedModels: [], maxEffort: "high", maxPermissionMode: "acceptEdits", showInDesktop: "on-request" },
};

/** Model names travel as command-line arguments and JSON fields: keep them plain. */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,119}$/;

export function policyPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.BRIDGE_POLICY_PATH?.trim() || join(dataDir(env), "policy.json");
}

function fail(path: string, problem: string): never {
  throw new Error(`The worker policy file ${path} is not valid: ${problem}. Fix it or remove it to use the defaults.`);
}

function oneOf<T extends string>(path: string, key: string, value: unknown, allowed: readonly T[], fallback: T): T {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(path, `${key} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function stringList(path: string, key: string, value: unknown, check?: (entry: string) => boolean): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim() || (check && !check(entry)))) {
    fail(path, `${key} must be a list of ${check ? "valid " : ""}non-empty strings`);
  }
  return (value as string[]).map((entry) => entry.trim());
}

function section(path: string, key: string, value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, `${key} must be an object`);
  return value as Record<string, unknown>;
}

/** Validate a parsed policy. Unknown keys are refused so a typo cannot silently loosen a limit. */
export function parsePolicy(raw: unknown, path = "policy.json"): WorkerPolicy {
  const root = section(path, "the file", raw);
  const codex = section(path, "codex", root.codex);
  const claude = section(path, "claude", root.claude);
  const known: Array<[Record<string, unknown>, string, string[]]> = [
    [root, "", ["maxStartsPerHour", "allowedRoots", "codex", "claude"]],
    [codex, "codex.", ["allowedModels", "maxEffort", "maxSandbox"]],
    [claude, "claude.", ["allowedModels", "maxEffort", "maxPermissionMode", "showInDesktop"]],
  ];
  for (const [object, prefix, keys] of known) {
    const unknown = Object.keys(object).find((key) => !keys.includes(key));
    if (unknown) fail(path, `unknown setting ${prefix}${unknown}`);
  }
  const starts = root.maxStartsPerHour ?? DEFAULT_POLICY.maxStartsPerHour;
  if (typeof starts !== "number" || !Number.isInteger(starts) || starts < 0 || starts > 1000) {
    fail(path, "maxStartsPerHour must be a whole number from 0 to 1000");
  }
  return {
    maxStartsPerHour: starts,
    allowedRoots: stringList(path, "allowedRoots", root.allowedRoots, isAbsolute),
    codex: {
      allowedModels: stringList(path, "codex.allowedModels", codex.allowedModels, (entry) => MODEL_NAME.test(entry)),
      maxEffort: oneOf(path, "codex.maxEffort", codex.maxEffort, EFFORT_LEVELS, DEFAULT_POLICY.codex.maxEffort),
      maxSandbox: oneOf(path, "codex.maxSandbox", codex.maxSandbox, WORKER_SANDBOX_MODES, DEFAULT_POLICY.codex.maxSandbox),
    },
    claude: {
      allowedModels: stringList(path, "claude.allowedModels", claude.allowedModels, (entry) => MODEL_NAME.test(entry)),
      maxEffort: oneOf(path, "claude.maxEffort", claude.maxEffort, EFFORT_LEVELS, DEFAULT_POLICY.claude.maxEffort),
      maxPermissionMode: oneOf(path, "claude.maxPermissionMode", claude.maxPermissionMode, CLAUDE_PERMISSION_MODES, DEFAULT_POLICY.claude.maxPermissionMode),
      showInDesktop: oneOf(path, "claude.showInDesktop", claude.showInDesktop, DESKTOP_HANDOFF_MODES, DEFAULT_POLICY.claude.showInDesktop),
    },
  };
}

export interface LoadedPolicy {
  policy: WorkerPolicy;
  /** The file the limits came from, or null when the built-in defaults apply. */
  source: string | null;
}

/** Read the owner's policy. A missing file means the defaults; a broken one is an error, never a fallback. */
export function loadPolicy(path = policyPath()): LoadedPolicy {
  if (!existsSync(path)) return { policy: DEFAULT_POLICY, source: null };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(path, `it is not readable JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  return { policy: parsePolicy(raw, path), source: path };
}

export interface WorkerRequest {
  worker: WorkerKind;
  projectPath: string;
  model?: string;
  effort?: string;
  /** Codex workers. */
  sandbox?: SandboxMode;
  /** Claude workers. */
  permissionMode?: ClaudePermissionMode;
  showInDesktop?: boolean;
  /** Worker chats already started in the last hour, across all bridge processes. */
  startsLastHour: number;
}

export interface WorkerDecision {
  showInDesktop: boolean;
  warnings: string[];
}

function resolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function inside(root: string, path: string): boolean {
  const offset = relative(resolved(root), resolved(path));
  return offset === "" || (!offset.startsWith(`..${sep}`) && offset !== ".." && !isAbsolute(offset));
}

/**
 * Check one request to start a worker chat against the ceiling. Throws with
 * the limit named when the request goes above it; nothing is lowered silently.
 */
export function checkWorkerRequest(policy: WorkerPolicy, request: WorkerRequest, source: string | null = null): WorkerDecision {
  const where = source ? `the owner's policy (${source})` : "the bridge's default policy";
  const refuse = (problem: string): never => {
    throw new Error(`${problem} That is above ${where}. Ask for less, or ask the user to raise the limit in policy.json; a tool call cannot change it.`);
  };
  const limits = request.worker === "codex" ? policy.codex : policy.claude;
  const label = request.worker === "codex" ? "Codex" : "Claude";

  if (request.startsLastHour >= policy.maxStartsPerHour) {
    refuse(`${request.startsLastHour} worker chats were started through this bridge in the last hour (limit ${policy.maxStartsPerHour}).`);
  }
  if (policy.allowedRoots.length > 0 && !policy.allowedRoots.some((root) => inside(root, request.projectPath))) {
    refuse(`${request.projectPath} is outside the folders workers may be started in (${policy.allowedRoots.join(", ")}).`);
  }
  if (request.model !== undefined) {
    if (!MODEL_NAME.test(request.model)) throw new Error(`"${request.model}" is not a valid model name.`);
    if (limits.allowedModels.length > 0 && !limits.allowedModels.includes(request.model)) {
      refuse(`${label} workers may use only these models: ${limits.allowedModels.join(", ")}; "${request.model}" is not one of them.`);
    }
  }
  if (request.effort !== undefined) {
    const rank = (EFFORT_LEVELS as readonly string[]).indexOf(request.effort);
    if (rank < 0) throw new Error(`"${request.effort}" is not a reasoning effort. Use one of: ${EFFORT_LEVELS.join(", ")}.`);
    if (rank > EFFORT_LEVELS.indexOf(limits.maxEffort)) {
      refuse(`Reasoning effort "${request.effort}" is higher than ${label} workers may use (up to "${limits.maxEffort}").`);
    }
  }
  if (request.worker === "codex" && request.sandbox !== undefined) {
    const rank = (WORKER_SANDBOX_MODES as readonly string[]).indexOf(request.sandbox);
    if (rank < 0) throw new Error(`Workers run in one of these sandboxes: ${WORKER_SANDBOX_MODES.join(", ")}.`);
    if (rank > (WORKER_SANDBOX_MODES as readonly string[]).indexOf(policy.codex.maxSandbox)) {
      refuse(`The "${request.sandbox}" sandbox gives more access than Codex workers may have (up to "${policy.codex.maxSandbox}").`);
    }
  }
  if (request.worker === "claude" && request.permissionMode !== undefined) {
    const rank = CLAUDE_PERMISSION_MODES.indexOf(request.permissionMode);
    if (rank < 0) throw new Error(`Claude workers run in one of these permission modes: ${CLAUDE_PERMISSION_MODES.join(", ")}.`);
    if (rank > CLAUDE_PERMISSION_MODES.indexOf(policy.claude.maxPermissionMode)) {
      refuse(`Permission mode "${request.permissionMode}" gives more autonomy than Claude workers may have (up to "${policy.claude.maxPermissionMode}").`);
    }
  }

  const warnings: string[] = [];
  let showInDesktop = false;
  if (request.worker === "claude") {
    const mode = policy.claude.showInDesktop;
    showInDesktop = mode === "always" || (mode === "on-request" && request.showInDesktop === true);
    if (request.showInDesktop === true && mode === "never") {
      warnings.push(`This chat will not be opened in the Claude desktop app: ${where} turns that off.`);
    }
  }
  return { showInDesktop, warnings };
}
