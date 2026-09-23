#!/usr/bin/env node
// Compile into a staging directory, then swap it in, so dist/ is never missing
// or half-written while an MCP client might be starting the server from it.
import { spawnSync } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const next = join(root, "dist.next");
const previous = join(root, "dist.old");

rmSync(next, { recursive: true, force: true });
const tsc = spawnSync(
  process.execPath,
  [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", join(root, "tsconfig.json"), "--outDir", next],
  { stdio: "inherit" },
);
if (tsc.status !== 0) {
  rmSync(next, { recursive: true, force: true });
  process.exit(tsc.status ?? 1);
}
rmSync(previous, { recursive: true, force: true });
if (existsSync(dist)) renameSync(dist, previous);
renameSync(next, dist);
rmSync(previous, { recursive: true, force: true });
