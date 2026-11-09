import { join } from "node:path";

export const MCP_NAME = "claude-codex-bridge";
export const PACKAGE_NAME = "claude-codex-mcp-bridge";
export const CLI_COMMANDS = [
  "setup",
  "doctor",
  "status",
  "demo",
  "retire",
  "prune",
  "backup",
  "rollback",
  "policy",
  "uninstall",
  "help",
] as const;
export type CliCommand = (typeof CLI_COMMANDS)[number];

/** Codex cuts MCP tool calls at 60 seconds by default; bridge waits need up to 290. */
export const CODEX_TOOL_TIMEOUT_SEC = 300;

export interface ParsedCliCommand {
  command: CliCommand;
  force: boolean;
  purge: boolean;
  fix: boolean;
  apply: boolean;
  keepBacklog: boolean;
  /** Positional argument, e.g. the agent for `retire`. */
  target: string | null;
  note: string | null;
  olderThanDays: number | null;
  /** setup: the Node.js binary both apps should launch the server with. */
  node: string | null;
}

export interface CommandPlan {
  get: string[];
  remove: string[];
  add: string[];
}

export interface RegistrationPlan {
  serverPath: string;
  claude: CommandPlan;
  codex: CommandPlan;
}

const BOOLEAN_FLAGS: Record<string, "force" | "purge" | "fix" | "apply" | "keepBacklog"> = {
  "--force": "force",
  "--purge": "purge",
  "--fix": "fix",
  "--apply": "apply",
  "--keep-backlog": "keepBacklog",
};

export function parseCliCommand(args: string[]): ParsedCliCommand {
  const parsed: ParsedCliCommand = {
    command: "help",
    force: false,
    purge: false,
    fix: false,
    apply: false,
    keepBacklog: false,
    target: null,
    note: null,
    olderThanDays: null,
    node: null,
  };
  const positionals: string[] = [];
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (BOOLEAN_FLAGS[arg]) {
      parsed[BOOLEAN_FLAGS[arg]] = true;
      continue;
    }
    const [flag, inline] = arg.split(/=(.*)/s, 2);
    if (flag === "--note" || flag === "--older-than" || flag === "--node") {
      const value = inline ?? args[++index];
      if (value === undefined) throw new Error(`${flag} needs a value`);
      if (flag === "--note") parsed.note = value;
      else if (flag === "--node") parsed.node = value;
      else {
        const days = Number(value.replace(/d$/i, ""));
        if (!Number.isFinite(days) || days <= 0) throw new Error("--older-than needs a positive number of days");
        parsed.olderThanDays = days;
      }
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    positionals.push(arg);
  }
  const raw = help ? "help" : positionals[0] ?? "help";
  if (!CLI_COMMANDS.includes(raw as CliCommand)) throw new Error(`Unknown command: ${raw}`);
  parsed.command = raw as CliCommand;
  parsed.target = help ? null : positionals[1] ?? null;
  if (!help && positionals.length > 2) throw new Error(`Unexpected argument: ${positionals[2]}`);
  if (parsed.command === "retire" && !parsed.target) throw new Error("retire needs an agent name");
  return parsed;
}

export function buildRegistrationPlan(input: {
  packageRoot: string;
  nodeBinary: string;
  claudeBinary?: string;
}): RegistrationPlan {
  const serverPath = join(input.packageRoot, "dist", "server.js");
  const claude = input.claudeBinary ?? "claude";
  return {
    serverPath,
    claude: {
      get: [claude, "mcp", "get", MCP_NAME],
      remove: [claude, "mcp", "remove", MCP_NAME, "--scope", "user"],
      add: [
        claude,
        "mcp",
        "add",
        "--scope",
        "user",
        MCP_NAME,
        "--",
        input.nodeBinary,
        serverPath,
      ],
    },
    codex: {
      get: ["codex", "mcp", "get", MCP_NAME],
      remove: ["codex", "mcp", "remove", MCP_NAME],
      add: ["codex", "mcp", "add", MCP_NAME, "--", input.nodeBinary, serverPath],
    },
  };
}

export function resolveSkillTargets(homeDirectory: string): string[] {
  return [join(homeDirectory, ".claude", "skills"), join(homeDirectory, ".agents", "skills")];
}

function versionParts(version: string): number[] {
  return version.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
}

/** Highest dotted version in a list, e.g. Claude Code builds bundled with the desktop app. */
export function newestVersion(versions: string[]): string | null {
  const valid = versions.filter((version) => /^\d+(\.\d+)*$/.test(version));
  return (
    valid.sort((a, b) => {
      const [left, right] = [versionParts(a), versionParts(b)];
      for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        const difference = (left[index] ?? 0) - (right[index] ?? 0);
        if (difference !== 0) return difference;
      }
      return 0;
    }).at(-1) ?? null
  );
}

/**
 * The Claude Code CLI used to register the server. A stale standalone
 * `claude` on PATH rewrites ~/.claude.json with its own older migration
 * marker, so prefer CLAUDE_BIN, then the newest build bundled with the
 * Claude desktop app, then PATH. `bundled` is that newest build's path when
 * one exists (see claude-binary.ts, which knows the app's folder layouts).
 */
export function resolveClaudeBinary(input: { configured?: string; bundled?: string | null }): string {
  if (input.configured?.trim()) return input.configured;
  return input.bundled || "claude";
}

export const NODE_VERSION_REQUIREMENT = "Node.js 22.x >=22.23.4, 24.x >=24.22.1, or 26.x >=26.12.1";

// October 21, 2026 security releases. New release lines need an explicit review.
const NODE_SECURITY_FLOORS = new Map<number, readonly [number, number]>([
  [22, [23, 4]],
  [24, [22, 1]],
  [26, [12, 1]],
]);

/** Accept stable releases that meet the security floor of a supported Node.js line. */
export function supportedNode(version: string): boolean {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match || match[0] !== version) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return false;
  const floor = NODE_SECURITY_FLOORS.get(major);
  return !!floor && (minor > floor[0] || (minor === floor[0] && patch >= floor[1]));
}
