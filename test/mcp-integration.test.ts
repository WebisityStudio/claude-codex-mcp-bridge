import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function connect(name: string, dbPath: string, extraEnv: Record<string, string> = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/server.ts"],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      BRIDGE_DB_PATH: dbPath,
      BRIDGE_BACKUPS: "0",
      XDG_DATA_HOME: join(dirname(dbPath), "data"),
      ...extraEnv,
    },
    stderr: "pipe",
  });
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  return client;
}

type CallResult = Awaited<ReturnType<Client["callTool"]>>;

function payload(result: CallResult) {
  const first = (result.content as Array<{ type: string; text?: string }>)[0];
  assert.equal(first?.type, "text");
  assert.equal(result.isError ?? false, false, first?.text);
  return JSON.parse(first?.text ?? "") as Record<string, unknown>;
}

function errorText(result: CallResult): string {
  assert.equal(result.isError, true);
  return (result.content as Array<{ text?: string }>)[0]?.text ?? "";
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
        "ask_codex",
        "bridge_ack",
        "bridge_agents",
        "bridge_continue_codex",
        "bridge_inbox",
        "bridge_orchestrate_codex",
        "bridge_orchestration_status",
        "bridge_orchestration_wait",
        "bridge_outbox",
        "bridge_register",
        "bridge_retire",
        "bridge_send",
        "bridge_sessions",
        "bridge_thread",
        "bridge_wait",
        "bridge_wake_status",
        "review_with_codex",
      ].sort(),
    );

    await claude.callTool({ name: "bridge_register", arguments: { agent: "claude", capabilities: ["architecture"] } });
    await codex.callTool({ name: "bridge_register", arguments: { agent: "codex", capabilities: ["implementation"] } });

    const sent = payload(
      await claude.callTool({
        name: "bridge_send",
        arguments: { from: "claude", to: "codex", body: "Please verify the implementation", threadId: "integration-test" },
      }),
    );
    assert.equal(sent.body, "Please verify the implementation");
    assert.equal(sent.warnings, undefined);

    const inbox = payload(await codex.callTool({ name: "bridge_inbox", arguments: { agent: "codex" } }));
    assert.equal(inbox.count, 1);
    assert.equal(inbox.totalUnread, 1);
    const messages = inbox.messages as Array<{ id: number; body: string }>;
    assert.equal(messages[0]?.body, "Please verify the implementation");

    const ack = payload(await codex.callTool({ name: "bridge_ack", arguments: { agent: "codex", ids: [messages[0]?.id] } }));
    assert.equal(ack.acknowledged, 1);
    assert.equal(ack.remainingUnread, 0);

    const waiting = codex.callTool({
      name: "bridge_wait",
      arguments: { agent: "codex", fromAgent: "claude", threadId: "automatic-loop", timeoutSeconds: 2 },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await claude.callTool({
      name: "bridge_send",
      arguments: { from: "claude", to: "codex", body: "This should wake the waiting Codex turn", threadId: "automatic-loop" },
    });
    const awakened = payload(await waiting);
    assert.equal(awakened.timedOut, false);
    assert.equal(awakened.count, 1);
    assert.equal((awakened.messages as Array<{ body: string }>)[0]?.body, "This should wake the waiting Codex turn");
  } finally {
    await Promise.all([claude.close(), codex.close()]);
  }
});

test("the bridge guards addressing, pages output and closes out finished agents", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-codex-bridge-guards-"));
  const dbPath = join(dir, "bridge.sqlite");
  const client = await connect("guards-client", dbPath);
  try {
    assert.match(errorText(await client.callTool({ name: "bridge_register", arguments: { agent: "bridge" } })), /reserved/);
    assert.match(
      errorText(await client.callTool({ name: "bridge_register", arguments: { agent: "01900000-0000-7000-8000-000000000000" } })),
      /session ID/,
    );
    await client.callTool({ name: "bridge_register", arguments: { agent: "lead" } });
    await client.callTool({ name: "bridge_register", arguments: { agent: "codex-worker" } });

    const typo = errorText(await client.callTool({ name: "bridge_send", arguments: { from: "lead", to: "codex-workr", body: "hi" } }));
    assert.match(typo, /Did you mean: codex-worker/);
    const later = payload(
      await client.callTool({ name: "bridge_send", arguments: { from: "lead", to: "not-yet", body: "hi", allowUnregistered: true } }),
    );
    assert.match(String((later.warnings as string[])[0]), /No agent named/);
    const anonymous = payload(await client.callTool({ name: "bridge_send", arguments: { from: "ghost", to: "lead", body: "hi" } }));
    assert.match(String((anonymous.warnings as string[])[0]), /not registered/);

    for (const body of ["one", "two", "three"]) {
      await client.callTool({ name: "bridge_send", arguments: { from: "lead", to: "codex-worker", body, threadId: "paging" } });
    }
    const page = payload(await client.callTool({ name: "bridge_inbox", arguments: { agent: "codex-worker", limit: 2 } }));
    assert.equal(page.count, 2);
    assert.equal(page.hasMore, true);
    const thread = payload(await client.callTool({ name: "bridge_thread", arguments: { threadId: "paging", limit: 2 } }));
    assert.deepEqual((thread.messages as Array<{ body: string }>).map((message) => message.body), ["two", "three"]);
    assert.equal(thread.total, 3);

    const outbox = payload(await client.callTool({ name: "bridge_outbox", arguments: { agent: "lead" } }));
    assert.equal(outbox.totalUnacknowledged, 4);

    const retired = payload(await client.callTool({ name: "bridge_retire", arguments: { agent: "codex-worker", note: "done" } }));
    assert.equal(retired.closed, 3);
    assert.equal((retired.agent as { retiredBy: string }).retiredBy, "codex-worker", "defaults to this conversation's latest agent");
    assert.match(
      errorText(await client.callTool({ name: "bridge_send", arguments: { from: "lead", to: "codex-worker", body: "more" } })),
      /retired/,
    );
    const agents = payload(await client.callTool({ name: "bridge_agents", arguments: {} }));
    assert.deepEqual((agents.agents as Array<{ name: string }>).map((agent) => agent.name), ["lead"]);
  } finally {
    await client.close();
  }
});

test("wake: auto binds the conversation that hosts the bridge process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-codex-bridge-auto-"));
  const client = await connect("auto-client", join(dir, "bridge.sqlite"), { CLAUDE_CODE_SESSION_ID: "session-under-test" });
  try {
    const registered = payload(await client.callTool({ name: "bridge_register", arguments: { agent: "auto-agent", wake: "auto" } }));
    assert.deepEqual(registered.wake, { app: "claude", sessionId: "session-under-test" });
    const sessions = payload(await client.callTool({ name: "bridge_sessions", arguments: {} }));
    assert.deepEqual(sessions.thisSession, { app: "claude", sessionId: "session-under-test" });
    const unbound = payload(await client.callTool({ name: "bridge_register", arguments: { agent: "auto-agent", wake: null } }));
    assert.equal(unbound.wake, null);
  } finally {
    await client.close();
  }
});
