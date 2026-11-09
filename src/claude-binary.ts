import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { newestVersion, resolveClaudeBinary } from "./cli-logic.js";

const APP_BINARY = ["claude.app", "Contents", "MacOS", "claude"];

/** Where the macOS desktop app keeps the Claude Code builds it downloads. */
export function bundledClaudeRoot(home = homedir(), platform: NodeJS.Platform = process.platform): string | null {
  return platform === "darwin" ? join(home, "Library", "Application Support", "Claude", "claude-code") : null;
}

/**
 * The newest Claude Code the desktop app has downloaded, or null. The app has
 * used two layouts: `<version>/claude.app` and, later, `<version>/<build>/claude.app`.
 */
export function bundledClaudeBinary(root: string | null = bundledClaudeRoot()): string | null {
  if (!root) return null;
  let versions: string[];
  try {
    versions = readdirSync(root);
  } catch {
    return null;
  }
  for (let newest = newestVersion(versions); newest; newest = newestVersion(versions)) {
    versions = versions.filter((version) => version !== newest);
    const flat = join(root, newest, ...APP_BINARY);
    if (existsSync(flat)) return flat;
    let builds: string[] = [];
    try {
      builds = readdirSync(join(root, newest));
    } catch {
      continue;
    }
    const nested = builds
      .map((build) => join(root, newest, build, ...APP_BINARY))
      .filter((path) => existsSync(path))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (nested[0]) return nested[0];
  }
  return null;
}

/**
 * The Claude Code CLI the bridge uses, for registration and for worker chats:
 * CLAUDE_BIN, then the newest build bundled with the desktop app, then PATH.
 */
export function claudeBinaryPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveClaudeBinary({ configured: env.CLAUDE_BIN, bundled: bundledClaudeBinary() });
}
