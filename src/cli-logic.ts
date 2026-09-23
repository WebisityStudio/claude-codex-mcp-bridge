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
 * Claude desktop app, then PATH.
 */
export function resolveClaudeBinary(input: { configured?: string; bundledRoot?: string; bundledVersions?: string[] }): string {
  if (input.configured?.trim()) return input.configured;
  const newest = input.bundledRoot ? newestVersion(input.bundledVersions ?? []) : null;
  return newest && input.bundledRoot
    ? join(input.bundledRoot, newest, "claude.app", "Contents", "MacOS", "claude")
    : "claude";
}

/** True for Node.js versions the bridge supports (22.5 or newer). */
export function supportedNode(version: string): boolean {
  const [major = 0, minor = 0] = versionParts(version.replace(/^v/, ""));
  return major > 22 || (major === 22 && minor >= 5);
}
