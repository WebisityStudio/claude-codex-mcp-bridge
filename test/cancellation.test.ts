import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { BridgeStore } from "../src/bridge-store.js";
import { waitForInbox } from "../src/inbox-waiter.js";
import {
  Orchestrator,
  type CodexRunner,
  type CodexTurnRequest,
  type CodexTurnResponse,
  type PrepareInput,
  type PreparedWorkspace,
  type WorkspaceManager,
} from "../src/orchestrator.js";

// A waiting tool call can lose its caller: the user stops the turn, the host
// times the call out, or the host process disappears. Whatever the bridge
// would have handed to that caller must stay available to the next one.

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function serverEnv(dbPath: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    BRIDGE_DB_PATH: dbPath,
    BRIDGE_BACKUPS: "0",
    XDG_DATA_HOME: join(dirname(dbPath), "data"),
    ...extra,
  };
}

async function connect(name: string, dbPath: string, extra: Record<string, string> = {}): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/server.ts"],
    cwd: projectRoot,
    env: serverEnv(dbPath, extra),
    stderr: "pipe",
  });
  const client = new Client({ name, version: "1.0.0" });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  const first = (result.content as Array<{ type: string; text?: string }>)[0];
  assert.equal(result.isError ?? false, false, first?.text);
  return JSON.parse(first?.text ?? "") as Record<string, unknown>;
}

async function eventually<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!accept(value) && Date.now() < deadline) {
    await sleep(100);
    value = await read();
  }
  return value;
}

test("a cancelled wait stops at once and hands nothing to the caller that left", async () => {
  const store = new BridgeStore(":memory:");
  try {
    const caller = new AbortController();
    const started = Date.now();
    const waiting = waitForInbox(store, { agent: "worker", timeoutMs: 5_000, pollIntervalMs: 10, signal: caller.signal });
    setTimeout(() => caller.abort(), 30);
    const result = await waiting;
    assert.equal(result.aborted, true);
    assert.equal(result.timedOut, false);
    assert.deepEqual(result.messages, []);
    assert.ok(Date.now() - started < 1_000, "the wait ends when the caller goes away, not at its timeout");

    // Messages already waiting are not handed to a caller that has gone either.
    store.send({ fromAgent: "lead", toAgent: "worker", body: "still unread" });
    const late = await waitForInbox(store, { agent: "worker", timeoutMs: 1_000, pollIntervalMs: 10, signal: caller.signal });
    assert.equal(late.aborted, true);
    assert.deepEqual(late.messages, []);
    assert.equal(store.inbox("worker").length, 1);
  } finally {
    store.close();
  }
});

class InstantWorkspace implements WorkspaceManager {
  async prepare(input: PrepareInput): Promise<PreparedWorkspace> {
    return { path: input.projectPath, branch: null, baseCommit: "abc123", uncommitted: [], includedUncommitted: true, warnings: [] };
  }
  async changes(): Promise<string[]> {
    return [];
  }
}

class GatedRunner implements CodexRunner {
  readonly turnTimeoutMs = 60_000;
  release!: () => void;
  private readonly gate = new Promise<void>((resolve) => (this.release = resolve));
  async run(request: CodexTurnRequest) {
    await this.gate;
    const response: CodexTurnResponse = { status: "completed", summary: "Finished after the caller left", evidence: [], filesChanged: [], tests: [], suggestedChips: [] };
    return { sessionId: request.sessionId ?? "codex-session-1", response };
  }
}

test("a Codex result is posted to the mailbox when the waiting caller cancelled", async () => {
  const store = new BridgeStore(":memory:");
  const runner = new GatedRunner();
  // A long delivery delay keeps the automatic mailbox post out of the way of the assertions.
  const orchestrator = new Orchestrator(store, runner, new InstantWorkspace(), { deliveryDelayMs: 60_000, pollMs: 5 });
  try {
    const caller = new AbortController();
    const startedAt = Date.now();
    const starting = orchestrator.start({
      coordinatorAgent: "lead",
      projectPath: "/repo",
      task: "Long task",
      threadId: "cancelled-run",
      useWorktree: false,
      maxRounds: 2,
      waitMs: 5_000,
      signal: caller.signal,
    });
    setTimeout(() => caller.abort(), 30);
    const started = await starting;
    assert.equal(started.status, "running_codex");
    assert.ok(Date.now() - startedAt < 1_000, "a cancelled call stops waiting for Codex");

    runner.release();
    await eventually(() => store.getRun(started.runId)?.status, (status) => status === "completed");

    // A second cancelled wait finds the finished round but must not take it.
    const ignored = await orchestrator.wait(started.runId, 1_000, caller.signal);
    assert.equal(ignored.status, "completed");
    assert.match(ignored.next ?? "", /mailbox/);
    assert.equal(store.getRun(started.runId)?.deliveredRound, 0, "the round stays undelivered for the mailbox");

    assert.equal(orchestrator.deliver(started.runId), true);
    const [message] = store.inbox("lead");
    assert.equal(message?.fromAgent, "bridge");
    assert.match(message?.body ?? "", /Finished after the caller left/);

    // A caller that is still listening takes the result inline, exactly once.
    const live = await orchestrator.wait(started.runId, 100);
    assert.match(live.next ?? "", /also posted/);
    assert.equal(store.inbox("lead").length, 1);
  } finally {
    orchestrator.close();
    store.close();
  }
});

test("a bridge_wait the caller cancelled does not acknowledge messages that arrive later", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-cancelled-wait-"));
  const client = await connect("cancelled-wait", join(dir, "bridge.sqlite"));
  try {
    await call(client, "bridge_register", { agent: "lead" });
    await call(client, "bridge_register", { agent: "worker" });

    const caller = new AbortController();
    const waiting = client
      .callTool({ name: "bridge_wait", arguments: { agent: "worker", timeoutSeconds: 20 } }, undefined, { signal: caller.signal })
      .then(() => "answered", () => "cancelled");
    await sleep(200);
    caller.abort("user stopped the turn");
    assert.equal(await waiting, "cancelled");
    await sleep(100);

    await call(client, "bridge_send", { from: "lead", to: "worker", body: "Sent after the wait was cancelled" });
    await sleep(700); // Longer than two polls of the abandoned wait.
    const inbox = await call(client, "bridge_inbox", { agent: "worker" });
    assert.equal(inbox.count, 1, "the message is still unread");
    assert.equal(inbox.totalUnread, 1);

    // A wait with a live caller still returns and acknowledges it.
    const next = await call(client, "bridge_wait", { agent: "worker", timeoutSeconds: 5 });
    assert.equal(next.count, 1);
    assert.equal(next.acknowledged, 1);
  } finally {
    await client.close();
  }
});

test("when the host disappears mid-wait the bridge exits without acknowledging later messages", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-host-gone-"));
  const dbPath = join(dir, "bridge.sqlite");
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: projectRoot,
    env: serverEnv(dbPath),
    stdio: ["pipe", "pipe", "ignore"],
  });
  let exited = false;
  child.once("exit", () => (exited = true));
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const replied = (id: number) =>
    eventually(() => output.split("\n").some((line) => line.includes(`"id":${id}`)), (found) => found, 15_000);

  try {
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "host-gone", version: "1" } } });
    assert.equal(await replied(1), true, "the server answers initialize");
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/call", params: { name: "bridge_register", arguments: { agent: "worker" } } });
    assert.equal(await replied(2), true);
    send({ id: 3, method: "tools/call", params: { name: "bridge_wait", arguments: { agent: "worker", timeoutSeconds: 30 } } });
    await sleep(300);

    child.stdin.end(); // The host is gone: end of input, no signal.
    await sleep(150);
    const store = new BridgeStore(dbPath);
    try {
      store.send({ fromAgent: "lead", toAgent: "worker", body: "Sent after the host disappeared" });
      await sleep(700); // Longer than two polls of the abandoned wait.
      assert.equal(store.inbox("worker").length, 1, "nobody acknowledged the message on the dead session's behalf");
    } finally {
      store.close();
    }
    assert.equal(await eventually(() => exited, (done) => done, 5_000), true, "the bridge exits when its host closes the pipe");
  } finally {
    if (!exited) child.kill("SIGKILL");
  }
});

const SLOW_FAKE_CODEX = `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const output = args[args.indexOf("-o") + 1];
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "fake-thread" }) + "\\n");
  setTimeout(() => {
    writeFileSync(output, JSON.stringify({ status: "completed", summary: "Review finished after the caller left", evidence: [], question: "", filesChanged: [], tests: [], suggestedChips: [] }));
  }, 500);
});
`;

test("a cancelled review_with_codex call still delivers its result to the coordinator", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-cancelled-run-"));
  const fake = join(dir, "fake");
  mkdirSync(fake);
  // ESM package scope must not apply to the fake binary.
  writeFileSync(join(fake, "package.json"), JSON.stringify({ type: "commonjs" }));
  const binary = join(fake, "codex");
  writeFileSync(binary, SLOW_FAKE_CODEX, { mode: 0o755 });
  chmodSync(binary, 0o755);
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "bridge-test@example.invalid");
  git("config", "user.name", "Bridge Test");
  writeFileSync(join(repo, "tracked.txt"), "committed\n");
  git("add", ".");
  git("commit", "-q", "-m", "initial");

  const client = await connect("cancelled-run", join(dir, "bridge.sqlite"), { CODEX_BIN: binary });
  try {
    await call(client, "bridge_register", { agent: "lead" });
    const caller = new AbortController();
    const running = client
      .callTool(
        { name: "review_with_codex", arguments: { projectPath: repo, coordinatorAgent: "lead", threadId: "cancelled-review", waitSeconds: 60 } },
        undefined,
        { signal: caller.signal },
      )
      .then(() => "answered", () => "cancelled");
    await sleep(250);
    caller.abort("user stopped the turn");
    assert.equal(await running, "cancelled");

    const inbox = await eventually(
      () => call(client, "bridge_inbox", { agent: "lead", threadId: "cancelled-review" }),
      (page) => page.count === 1,
    );
    assert.equal(inbox.count, 1, "the finished result reached the coordinator's mailbox");
    const [message] = inbox.messages as Array<{ fromAgent: string; body: string }>;
    assert.equal(message?.fromAgent, "bridge");
    assert.match(message?.body ?? "", /Review finished after the caller left/);
  } finally {
    await client.close();
  }
});
