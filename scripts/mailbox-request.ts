#!/usr/bin/env node
// Explicit-database MCP client for isolated smoke tests. Never defaults to the live mailbox.
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [db, name, raw = "{}"] = process.argv.slice(2);
if (!db || !name || !db.startsWith("/")) throw new Error("Usage: node --import tsx scripts/mailbox-request.ts ABSOLUTE_DB TOOL JSON_ARGUMENTS");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const client = new Client({ name: "isolated-wake-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({
  command: process.execPath, args: ["--import", "tsx", "src/server.ts"], cwd: root,
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
