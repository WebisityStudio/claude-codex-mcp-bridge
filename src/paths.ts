import { homedir } from "node:os";
import { join } from "node:path";

import { DATA_DIR_NAME } from "./fs-safety.js";

type Env = NodeJS.ProcessEnv;

function setting(env: Env, key: string): string | null {
  const value = env[key]?.trim();
  return value ? value : null;
}

/** XDG data home, falling back to ~/.local/share on every platform. */
export function dataHome(env: Env = process.env, home = homedir()): string {
  return setting(env, "XDG_DATA_HOME") ?? join(home, ".local", "share");
}

export function dataDir(env: Env = process.env, home = homedir()): string {
  return join(dataHome(env, home), DATA_DIR_NAME);
}

/** The shared mailbox. Every MCP process must resolve the same file. */
export function defaultDbPath(env: Env = process.env, home = homedir()): string {
  return setting(env, "BRIDGE_DB_PATH") ?? join(dataDir(env, home), "bridge.sqlite");
}

export function runsDir(env: Env = process.env, home = homedir()): string {
  return join(dataDir(env, home), "runs");
}

/** Worktrees live outside the repository so watchers, test runners and git status ignore them. */
export function worktreeRoot(env: Env = process.env, home = homedir()): string {
  return setting(env, "BRIDGE_WORKTREE_ROOT") ?? join(dataDir(env, home), "worktrees");
}

export function runtimePrefix(env: Env = process.env, home = homedir()): string {
  return join(dataDir(env, home), "runtime");
}
