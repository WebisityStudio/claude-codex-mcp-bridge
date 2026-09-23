import { chmodSync, lstatSync, mkdirSync } from "node:fs";

/** Name of the per-user data directory under the XDG data home. */
export const DATA_DIR_NAME = "claude-codex-bridge";

/**
 * Remove group/other permissions from a path this user owns. Symlinks and
 * paths owned by someone else are left alone. Returns true when it changed
 * the mode. A no-op on Windows, where POSIX modes do not apply.
 */
export function restrictToOwner(path: string): boolean {
  if (process.platform === "win32") return false;
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || stat.uid !== process.getuid?.()) return false;
    if ((stat.mode & 0o077) === 0) return false;
    chmodSync(path, stat.mode & 0o700);
    return true;
  } catch {
    return false;
  }
}

/** Create a private directory (0700) and tighten it if it already existed. */
export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  restrictToOwner(path);
}

/** Octal permission string for diagnostics, e.g. "0600". */
export function modeString(path: string): string | null {
  try {
    return `0${(lstatSync(path).mode & 0o777).toString(8)}`;
  } catch {
    return null;
  }
}
