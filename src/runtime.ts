import { existsSync, lstatSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { PACKAGE_NAME } from "./cli-logic.js";

/**
 * Installed runtimes live in `versions/<id>`; `current` is a symlink (a
 * junction on Windows) that the MCP registrations point through. Switching
 * versions is one atomic rename, and rollback is the same switch backwards.
 * Running sessions keep the code they loaded; new sessions get the new link.
 */
export interface RuntimeLayout {
  prefix: string;
  versionsDir: string;
  currentLink: string;
}

export function runtimeLayout(prefix: string): RuntimeLayout {
  return { prefix, versionsDir: join(prefix, "versions"), currentLink: join(prefix, "current") };
}

export function packageRootIn(directory: string): string {
  return join(directory, "node_modules", PACKAGE_NAME);
}

export function currentPackageRoot(layout: RuntimeLayout): string {
  return packageRootIn(layout.currentLink);
}

export function serverPathFor(packageRoot: string): string {
  return join(packageRoot, "dist", "server.js");
}

/** Sortable version id: UTC timestamp first, then the package version. */
export function versionId(version: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${stamp}-v${version}`;
}

/** Installed version ids, newest first. */
export function listVersions(layout: RuntimeLayout): string[] {
  try {
    return readdirSync(layout.versionsDir)
      .filter((name) => /^\d{8}T\d{6}Z-v/.test(name))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

export function currentVersion(layout: RuntimeLayout): string | null {
  try {
    if (!lstatSync(layout.currentLink).isSymbolicLink()) return null;
    return basename(readlinkSync(layout.currentLink));
  } catch {
    return null;
  }
}

/** The version to return to on rollback: the newest one older than the current version. */
export function previousVersion(ids: string[], current: string | null): string | null {
  if (!current) return ids[0] ?? null;
  return ids.find((id) => id < current) ?? null;
}

/** Old versions to delete, always keeping the current and previous ones. */
export function versionsToPrune(ids: string[], current: string | null, keep = 3): string[] {
  const protectedIds = new Set([current, previousVersion(ids, current)].filter(Boolean) as string[]);
  const kept = new Set<string>(protectedIds);
  for (const id of ids) {
    if (kept.size >= Math.max(keep, protectedIds.size)) break;
    kept.add(id);
  }
  return ids.filter((id) => !kept.has(id));
}

/** Atomically point `current` at an installed version. */
export function activateVersion(layout: RuntimeLayout, id: string): void {
  const target = join(layout.versionsDir, id);
  if (!existsSync(target)) throw new Error(`Runtime version not installed: ${id}`);
  const temporary = `${layout.currentLink}.next-${process.pid}`;
  rmSync(temporary, { force: true, recursive: false });
  if (process.platform === "win32") {
    symlinkSync(resolve(target), temporary, "junction");
    rmSync(layout.currentLink, { force: true, recursive: false });
    renameSync(temporary, layout.currentLink);
    return;
  }
  // A relative link keeps working if the data directory moves.
  symlinkSync(join("versions", id), temporary);
  renameSync(temporary, layout.currentLink);
}

export function removeVersions(layout: RuntimeLayout, ids: string[]): void {
  for (const id of ids) rmSync(join(layout.versionsDir, id), { recursive: true, force: true });
}
