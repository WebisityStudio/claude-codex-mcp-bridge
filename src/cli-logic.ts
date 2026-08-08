import { join } from "node:path";

export const MCP_NAME = "claude-codex-bridge";
export const PACKAGE_NAME = "claude-codex-mcp-bridge";
export const CLI_COMMANDS = ["setup", "doctor", "status", "demo", "uninstall", "help"] as const;
export type CliCommand = (typeof CLI_COMMANDS)[number];

export interface ParsedCliCommand {
  command: CliCommand;
  force: boolean;
  purge: boolean;
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

export function parseCliCommand(args: string[]): ParsedCliCommand {
  const raw = args.find((arg) => !arg.startsWith("--")) ?? "help";
  if (!CLI_COMMANDS.includes(raw as CliCommand)) {
    throw new Error(`Unknown command: ${raw}`);
  }
  const allowedFlags = new Set(["--force", "--purge", "--help", "-h"]);
  for (const arg of args) {
    if (arg.startsWith("-") && !allowedFlags.has(arg)) {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return {
    command: raw === "--help" || raw === "-h" ? "help" : (raw as CliCommand),
    force: args.includes("--force"),
    purge: args.includes("--purge"),
  };
}

export function buildRegistrationPlan(input: {
  packageRoot: string;
  nodeBinary: string;
}): RegistrationPlan {
  const serverPath = join(input.packageRoot, "dist", "server.js");
  return {
    serverPath,
    claude: {
      get: ["claude", "mcp", "get", MCP_NAME],
      remove: ["claude", "mcp", "remove", MCP_NAME, "--scope", "user"],
      add: [
        "claude",
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

export function resolveRuntimePrefix(homeDirectory: string): string {
  return join(homeDirectory, ".local", "share", MCP_NAME, "runtime");
}

export function resolveSkillTargets(homeDirectory: string): string[] {
  return [join(homeDirectory, ".claude", "skills"), join(homeDirectory, ".agents", "skills")];
}
