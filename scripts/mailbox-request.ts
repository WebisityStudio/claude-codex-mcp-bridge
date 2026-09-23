#!/usr/bin/env node
// One-shot MCP client for a named mailbox. Test mailboxes run this checkout's
// source. The live mailbox is only ever served by the installed runtime, so a
// half-edited checkout can never migrate or rewrite real data.
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { defaultDbPath, runtimePrefix } from "../src/paths.js";
import { currentPackageRoot, runtimeLayout, serverPathFor } from "../src/runtime.js";

const [db, name, raw = "{}"] = process.argv.slice(2);
if (!db || !name || !db.startsWith("/")) throw new Error("Usage: node --import tsx scripts/mailbox-request.ts ABSOLUTE_DB TOOL JSON_ARGUMENTS");

function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const live = samePath(db, defaultDbPath({ ...process.env, BRIDGE_DB_PATH: "" }));
const installed = serverPathFor(currentPackageRoot(runtimeLayout(runtimePrefix())));
if (live && !existsSync(installed)) {
  throw new Error(
    `${db} is the live mailbox. Development source never runs against it. Install the bridge first (npm run build && node dist/cli.js setup); live requests then use the installed runtime.`,
  );
}
process.stderr.write(`[mailbox-request] ${live ? `live mailbox via installed runtime ${installed}` : "test mailbox via this checkout's source"}\n`);

const client = new Client({ name: "mailbox-request", version: "1.0.0" });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: live ? [installed] : ["--import", "tsx", "src/server.ts"],
  cwd: live ? dirname(installed) : root,
  env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", BRIDGE_DB_PATH: db },
  stderr: "pipe",
}));
try {
  const response = await client.callTool({ name, arguments: JSON.parse(raw) });
  for (const item of response.content as Array<{ type: string; text?: string }>) {
    if (item.type === "text") console.log(item.text);
  }
  if (response.isError) process.exitCode = 1;
} finally { await client.close(); }
