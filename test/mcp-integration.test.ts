import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function connect(name: string, dbPath: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/server.ts"],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      BRIDGE_DB_PATH: dbPath,
    },
    stderr: "pipe",
  });
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  return client;
}

function payload(result: Awaited<ReturnType<Client["callTool"]>>) {
  const first = result.content[0];
  assert.equal(first?.type, "text");
  if (!first || first.type !== "text") throw new Error("Expected text result");
  return JSON.parse(first.text) as Record<string, unknown>;
}

test("two independent MCP clients exchange and acknowledge a message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-codex-bridge-mcp-"));
  const dbPath = join(dir, "bridge.sqlite");
  const claude = await connect("claude-test-client", dbPath);
  const codex = await connect("codex-test-client", dbPath);

  try {
    const tools = await claude.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      [
        "bridge_ack",
        "bridge_agents",
        "bridge_continue_codex",
        "bridge_inbox",
        "bridge_orchestrate_codex",
        "bridge_orchestration_status",
        "bridge_register",
        "bridge_send",
        "bridge_thread",
        "bridge_wait",
        "ask_codex",
        "review_with_codex",
      ].sort(),
    );

    await claude.callTool({
      name: "bridge_register",
      arguments: { agent: "claude", capabilities: ["architecture"] },
    });
    await codex.callTool({
      name: "bridge_register",
      arguments: { agent: "codex", capabilities: ["implementation"] },
    });

    const sent = payload(
      await claude.callTool({
        name: "bridge_send",
        arguments: {
          from: "claude",
          to: "codex",
          body: "Please verify the implementation",
          threadId: "integration-test",
        },
      }),
    );
    assert.equal(sent.body, "Please verify the implementation");

    const inbox = payload(
      await codex.callTool({
        name: "bridge_inbox",
        arguments: { agent: "codex" },
      }),
    );
    assert.equal(inbox.count, 1);
    const messages = inbox.messages as Array<{ id: number; body: string }>;
    assert.equal(messages[0]?.body, "Please verify the implementation");

    const ack = payload(
      await codex.callTool({
        name: "bridge_ack",
        arguments: { agent: "codex", ids: [messages[0]?.id] },
      }),
    );
    assert.equal(ack.acknowledged, 1);

    const emptyInbox = payload(
      await codex.callTool({
        name: "bridge_inbox",
        arguments: { agent: "codex" },
      }),
    );
    assert.equal(emptyInbox.count, 0);

    const waiting = codex.callTool({
      name: "bridge_wait",
      arguments: {
        agent: "codex",
        fromAgent: "claude",
        threadId: "automatic-loop",
        timeoutSeconds: 2,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await claude.callTool({
      name: "bridge_send",
      arguments: {
        from: "claude",
        to: "codex",
        body: "This should wake the waiting Codex turn",
        threadId: "automatic-loop",
      },
    });
    const awakened = payload(await waiting);
    assert.equal(awakened.timedOut, false);
    assert.equal(awakened.count, 1);
    const awakenedMessages = awakened.messages as Array<{ body: string }>;
    assert.equal(awakenedMessages[0]?.body, "This should wake the waiting Codex turn");
  } finally {
    await Promise.all([claude.close(), codex.close()]);
  }
});
