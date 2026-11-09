import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { BridgeStore } from "../src/bridge-store.js";
import { DEFAULT_PAGE_CHARS, fitRows } from "../src/paging.js";

// bridge_agents and bridge_wake_status grow with the mailbox. Like inbox and
// thread reads, they must stay inside the page budget however large it gets.

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("rows are kept in order until the page budget is spent, and the first always returns", () => {
  const rows = Array.from({ length: 40 }, (_, index) => ({ id: index, text: "x".repeat(900) }));
  const fitted = fitRows(rows, 10_000);
  assert.ok(fitted.rows.length > 1 && fitted.rows.length < rows.length);
  assert.deepEqual(fitted.rows.map((row) => row.id), rows.slice(0, fitted.rows.length).map((row) => row.id));
  assert.equal(fitted.omitted, rows.length - fitted.rows.length);
  assert.ok(JSON.stringify({ rows: fitted.rows }, null, 2).length <= 10_000);

  const oversized = fitRows([{ id: 1, text: "x".repeat(50_000) }, { id: 2, text: "small" }], 10_000);
  assert.deepEqual(oversized.rows.map((row) => row.id), [1], "a reader can always make progress");
  assert.deepEqual(fitRows([], 10_000), { rows: [], omitted: 0 });
});

test("agent pages list the most recently active first and can be searched and resumed", async () => {
  const store = new BridgeStore(":memory:");
  try {
    store.register("alpha-review", ["review"]);
    store.register("beta-build", ["implementation"]);
    store.register("gamma-review", ["Architecture"]);
    store.register("old-task");
    store.retire("old-task", { by: "operator" });
    await sleep(5);
    store.send({ fromAgent: "alpha-review", toAgent: "beta-build", body: "work for beta" });
    await sleep(5);
    store.touch("gamma-review");

    const all = store.agentPage();
    assert.equal(all.total, 3);
    assert.deepEqual(all.agents.map((agent) => agent.name), ["gamma-review", "alpha-review", "beta-build"]);
    assert.equal(all.agents.find((agent) => agent.name === "beta-build")?.unread, 1);
    assert.deepEqual(
      all.agents.map((agent) => agent.lastActivity),
      store.agentSummaries().sort((a, b) => b.lastActivity.localeCompare(a.lastActivity)).map((agent) => agent.lastActivity),
      "activity matches the per-agent summaries",
    );

    const first = store.agentPage({ limit: 2 });
    assert.deepEqual(first.agents.map((agent) => agent.name), ["gamma-review", "alpha-review"]);
    assert.equal(first.total, 3);
    assert.deepEqual(store.agentPage({ limit: 2, offset: 2 }).agents.map((agent) => agent.name), ["beta-build"]);

    assert.deepEqual(store.agentPage({ query: "REVIEW" }).agents.map((agent) => agent.name), ["gamma-review", "alpha-review"]);
    assert.deepEqual(store.agentPage({ query: "architecture" }).agents.map((agent) => agent.name), ["gamma-review"], "capabilities are searched too");
    assert.equal(store.agentPage({ query: "nobody" }).total, 0);
    assert.equal(store.agentPage({ includeRetired: true }).total, 4);
    assert.deepEqual(store.agentPage({ query: "old", includeRetired: true }).agents.map((agent) => agent.name), ["old-task"]);
  } finally {
    store.close();
  }
});

test("ping receipts can be read in bounded pages with a summary of the latest ones", () => {
  const store = new BridgeStore(":memory:");
  try {
    store.wakes.bind("worker", { app: "codex", sessionId: "task-1" });
    store.wakes.bind("reviewer", { app: "claude", sessionId: "session-1" });
    for (let index = 0; index < 8; index += 1) {
      store.send({ fromAgent: "lead", toAgent: index % 2 ? "reviewer" : "worker", body: `message ${index}` });
    }
    const states = ["accepted", "held", "refused", "unknown"] as const;
    for (let index = 0, job = store.wakes.claim(); job; index += 1, job = store.wakes.claim()) {
      store.wakes.finish(job, { state: states[index % states.length], detail: `finished ${index}` });
    }

    const newest = store.wakes.list(undefined, { limit: 3 });
    assert.equal(newest.length, 3);
    const older = store.wakes.list(undefined, { limit: 3, beforeId: newest.at(-1)?.id });
    assert.equal(older.length, 3);
    assert.ok(older[0].id < (newest.at(-1)?.id ?? 0), "pages move strictly back in time");
    assert.equal(store.wakes.list().length, 8, "the default still returns the latest hundred");
    assert.ok(store.wakes.list("worker").every((job) => job.agent === "worker"));
    assert.equal(store.wakes.list("worker", { limit: 2 }).length, 2);

    const recent = store.wakes.recentStates();
    assert.equal(recent.jobs, 8);
    assert.deepEqual(recent.byState, { accepted: 2, held: 2, refused: 2, unknown: 2 });
    assert.equal(recent.claudeHold, true, "a held Claude ping is flagged for explanation");
    assert.equal(store.wakes.recentStates("worker").claudeHold, false);
    assert.equal(store.wakes.recentStates(undefined, 3).jobs, 3);
  } finally {
    store.close();
  }
});

interface Called {
  text: string;
  payload: Record<string, unknown>;
}

async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Called> {
  const result = await client.callTool({ name, arguments: args });
  const first = (result.content as Array<{ type: string; text?: string }>)[0];
  assert.equal(result.isError ?? false, false, first?.text);
  const text = first?.text ?? "";
  return { text, payload: JSON.parse(text) as Record<string, unknown> };
}

test("agent and ping listings stay inside the page budget on a large mailbox", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-output-caps-"));
  const dbPath = join(dir, "bridge.sqlite");
  const AGENTS = 260;
  const PINGED = 150;

  // Seed a mailbox the size of a busy month. Every ping is settled here, and the
  // sender is never registered, so the server under test has nothing to deliver.
  const seed = new BridgeStore(dbPath);
  try {
    for (let index = 0; index < AGENTS; index += 1) {
      const name = `seed-agent-${String(index).padStart(3, "0")}-with-a-realistically-long-task-name`;
      seed.register(name, ["review", "implementation", "architecture"]);
      if (index < PINGED) {
        seed.wakes.bind(name, { app: index % 2 ? "claude" : "codex", sessionId: randomUUID() });
        seed.send({ fromAgent: "seed-sender", toAgent: name, body: "Please pick this up. ".repeat(40), threadId: `seed-thread-${index}` });
      }
    }
    const states = ["accepted", "held", "refused", "unknown"] as const;
    for (let index = 0, job = seed.wakes.claim(); job; index += 1, job = seed.wakes.claim()) {
      seed.wakes.finish(job, { state: states[index % states.length], detail: "Seeded outcome for a listing test, written at a realistic length." });
    }
    seed.register("retired-agent");
    seed.retire("retired-agent", { by: "operator", note: "finished" });
  } finally {
    seed.close();
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/server.ts"],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH ?? "",
      // A throwaway home: no adapter in this process can reach a real app.
      HOME: dir,
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      BRIDGE_DB_PATH: dbPath,
      BRIDGE_BACKUPS: "0",
      XDG_DATA_HOME: join(dir, "data"),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "output-caps", version: "1.0.0" });
  await client.connect(transport);
  try {
    // --- bridge_agents ---
    const agents = await callTool(client, "bridge_agents");
    assert.ok(agents.text.length <= DEFAULT_PAGE_CHARS, `default agent list is ${agents.text.length} characters`);
    assert.equal(agents.payload.count, 50);
    assert.equal(agents.payload.total, AGENTS);
    assert.equal(agents.payload.hasMore, true);
    assert.equal(agents.payload.nextOffset, 50);
    const firstAgent = (agents.payload.agents as Array<Record<string, unknown>>)[0];
    assert.equal("retiredAt" in firstAgent, false, "empty retirement fields are left out");
    assert.equal(typeof firstAgent.unread, "number");

    const widest = await callTool(client, "bridge_agents", { limit: 200 });
    assert.ok(widest.text.length <= DEFAULT_PAGE_CHARS, `largest agent page is ${widest.text.length} characters`);
    assert.equal(widest.payload.hasMore, true);
    assert.equal(widest.payload.nextOffset, widest.payload.count, "the cursor continues after the rows that fitted");

    const seen = new Set<string>();
    let offset: number | null = 0;
    for (let page = 0; offset !== null && page < 50; page += 1) {
      const next = await callTool(client, "bridge_agents", { limit: 200, offset });
      assert.ok(next.text.length <= DEFAULT_PAGE_CHARS);
      for (const agent of next.payload.agents as Array<{ name: string }>) seen.add(agent.name);
      offset = next.payload.nextOffset as number | null;
    }
    assert.equal(seen.size, AGENTS, "paging reaches every agent exactly once");

    const found = await callTool(client, "bridge_agents", { query: "seed-agent-00" });
    assert.equal(found.payload.total, 10);
    assert.equal(found.payload.hasMore, false);
    assert.equal(found.payload.nextOffset, null);
    const retired = await callTool(client, "bridge_agents", { query: "retired-agent", includeRetired: true });
    assert.equal((retired.payload.agents as Array<{ retiredBy?: string }>)[0]?.retiredBy, "operator");

    // --- bridge_wake_status ---
    const status = await callTool(client, "bridge_wake_status");
    assert.ok(status.text.length <= DEFAULT_PAGE_CHARS, `default ping status is ${status.text.length} characters`);
    const jobs = status.payload.jobs as Array<Record<string, unknown>>;
    assert.equal(jobs.length, 20);
    assert.equal(status.payload.count, 20);
    assert.equal(status.payload.hasMore, true);
    assert.equal(status.payload.olderBeforeId, jobs.at(-1)?.id);
    assert.equal(status.payload.mailboxPath, dbPath, "the mailbox path is stated once");
    assert.equal(jobs.some((job) => "mailboxPath" in job), false);
    assert.ok(jobs.every((job) => String(job.preview ?? "").length <= 120));
    const summary = status.payload.summary as Record<string, number>;
    assert.equal(Object.values(summary).reduce((sum, value) => sum + value, 0), 100, "the summary covers the latest hundred");
    assert.equal(status.payload.summaryOf, 100);
    assert.match(String(status.payload.explanation), /Bypass permissions/);

    const most = await callTool(client, "bridge_wake_status", { limit: 100 });
    assert.ok(most.text.length <= DEFAULT_PAGE_CHARS, `largest ping page is ${most.text.length} characters`);

    const jobIds = new Set<number>();
    let beforeId: number | null | undefined;
    for (let page = 0; beforeId !== null && page < 50; page += 1) {
      const next = await callTool(client, "bridge_wake_status", { limit: 100, ...(beforeId ? { beforeId } : {}) });
      assert.ok(next.text.length <= DEFAULT_PAGE_CHARS);
      for (const job of next.payload.jobs as Array<{ id: number }>) jobIds.add(job.id);
      beforeId = next.payload.olderBeforeId as number | null;
    }
    assert.equal(jobIds.size, PINGED, "paging reaches every receipt exactly once");

    const one = await callTool(client, "bridge_wake_status", { agent: "seed-agent-003-with-a-realistically-long-task-name" });
    assert.equal(one.payload.count, 1);
    assert.equal(one.payload.hasMore, false);
    assert.equal(one.payload.olderBeforeId, null);
  } finally {
    await client.close();
  }
});
