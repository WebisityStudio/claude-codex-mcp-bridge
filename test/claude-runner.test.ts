import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { TurnFiles } from "../src/bridge-store.js";
import { manualHandoffCommand, showInClaudeDesktop } from "../src/claude-desktop.js";
import { ClaudeCliRunner, buildClaudeArgs, claudeEnvelope } from "../src/claude-runner.js";
import { fakeClaude } from "./helpers/fakes.js";


const ID = "11111111-2222-4333-8444-555555555555";

test("a headless Claude turn names its session, permission mode and choices, and loads no MCP servers", () => {
  const fresh = buildClaudeArgs({ sessionId: ID, resume: false, permissionMode: "acceptEdits", model: "haiku", effort: "low", title: "Bridge: fix login" });
  assert.deepEqual(fresh.slice(0, 5), ["-p", "--output-format", "json", "--session-id", ID]);
  const after = (flag: string) => fresh[fresh.indexOf(flag) + 1];
  assert.equal(after("--permission-mode"), "acceptEdits");
  assert.equal(after("--model"), "haiku");
  assert.equal(after("--effort"), "low");
  assert.equal(after("--name"), "Bridge: fix login");
  assert.equal(after("--mcp-config"), '{"mcpServers":{}}');
  assert.ok(fresh.includes("--strict-mcp-config"));
  assert.deepEqual(JSON.parse(after("--json-schema")).required, ["status", "summary", "evidence", "question", "filesChanged", "tests", "suggestedChips"]);
  assert.equal(fresh.some((arg) => /bypass|dangerously/i.test(arg)), false);

  const resumed = buildClaudeArgs({ sessionId: ID, resume: true, permissionMode: "plan", title: "ignored on resume" });
  assert.deepEqual(resumed.slice(3, 5), ["--resume", ID]);
  assert.equal(resumed.includes("--session-id"), false);
  assert.equal(resumed.includes("--name"), false, "a resumed chat keeps its name");
  assert.equal(resumed.includes("--model"), false, "no model means Claude Code's default");
});

test("Claude's answer becomes the worker envelope, whichever way it was written", () => {
  const envelope = { status: "blocked", summary: "needs approval", evidence: ["e"], question: "", filesChanged: [], tests: [], suggestedChips: [] };
  assert.equal(claudeEnvelope({ structured_output: envelope, result: "ignored" }).status, "blocked");
  assert.equal(claudeEnvelope({ result: `\`\`\`json\n${JSON.stringify(envelope)}\n\`\`\`` }).summary, "needs approval");
  const plain = claudeEnvelope({ result: "All good, nothing to change." });
  assert.deepEqual([plain.status, plain.summary], ["completed", "All good, nothing to change."]);
  assert.equal(claudeEnvelope({ result: '{"status":"nonsense"}' }).status, "completed", "an invalid envelope falls back to the plain answer");
  assert.match(claudeEnvelope({}).summary, /without a written answer/);
});

test("the Claude runner drives a detached turn, resumes it and explains failures", { skip: process.platform === "win32" }, async () => {
  const fake = fakeClaude();
  const runner = new ClaudeCliRunner({ binary: fake.binary, dataDir: join(fake.dir, "runs"), timeoutMs: 20_000 });
  const sessions: string[] = [];
  const spawned: Array<{ files: TurnFiles | null }> = [];

  const first = await runner.run(
    { cwd: fake.dir, prompt: "hello world", sessionId: null, sandbox: "workspace-write", permissionMode: "acceptEdits", model: "haiku", effort: "low", title: "Bridge: hello" },
    { onSession: (id) => sessions.push(id), onSpawn: (info) => spawned.push(info) },
  );
  assert.match(first.sessionId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(sessions, [first.sessionId], "the session is known as soon as the turn starts");
  assert.match(first.response.summary, /handled: hello world/);
  assert.equal(first.warnings, undefined);
  const call = fake.calls()[0];
  assert.equal(call[call.indexOf("--session-id") + 1], first.sessionId);
  assert.equal(call[call.indexOf("--permission-mode") + 1], "acceptEdits");

  const resumed = await runner.run({ cwd: fake.dir, prompt: "continue", sessionId: first.sessionId, sandbox: "read-only" });
  assert.equal(resumed.sessionId, first.sessionId);
  const second = fake.calls()[1];
  assert.equal(second[second.indexOf("--resume") + 1], first.sessionId);
  assert.equal(second[second.indexOf("--permission-mode") + 1], "plan", "a read-only run without a stated mode uses plan");

  const plain = await runner.run({ cwd: fake.dir, prompt: "[[plain]] answer please", sessionId: null, sandbox: "read-only", permissionMode: "manual" });
  assert.equal(plain.response.summary, "Here is what I found: all good.");

  const denied = await runner.run({ cwd: fake.dir, prompt: "[[denied]] tools", sessionId: null, sandbox: "read-only", permissionMode: "manual" });
  assert.match(denied.warnings?.[0] ?? "", /refused 3 tool call\(s\) \(Bash, Edit\)/);

  await assert.rejects(
    runner.run({ cwd: fake.dir, prompt: "[[signed-out]]", sessionId: null, sandbox: "read-only" }),
    /Claude could not run the turn: Failed to authenticate.*claude auth login/s,
  );
  await assert.rejects(
    runner.run({ cwd: fake.dir, prompt: "[[garbage]]", sessionId: null, sandbox: "read-only" }),
    /Claude exited 2: claude: something broke/,
  );

  // Another bridge process can finish the turn from its files alone.
  assert.equal(runner.recover(spawned[0]?.files as TurnFiles, first.sessionId).sessionId, first.sessionId);
});

test("a finished Claude chat is handed to the desktop app through a terminal the bridge provides", { skip: process.platform !== "darwin" }, async () => {
  const fake = fakeClaude();
  const shown = await showInClaudeDesktop({ binary: fake.binary, cwd: fake.dir, sessionId: ID });
  assert.deepEqual([shown.shown, shown.detail], [true, "Opened in the Claude desktop app."]);
  const call = fake.calls().at(-1) ?? [];
  assert.deepEqual(call, ["--desktop", "--resume", ID]);

  const missing = await showInClaudeDesktop({ binary: join(fake.dir, "no-such-claude"), cwd: fake.dir, sessionId: ID });
  assert.equal(missing.shown, false);
  assert.match(missing.detail, /did not open the chat in the desktop app/);
});

test("where the hand-off cannot be automated, the command to run by hand is given", async () => {
  const elsewhere = await showInClaudeDesktop({ binary: "/opt/Claude Code/claude", cwd: tmpdir(), sessionId: ID, platform: "linux" });
  assert.equal(elsewhere.shown, false);
  assert.match(elsewhere.detail, /only automated on macOS/);
  assert.equal(elsewhere.manualCommand, `'/opt/Claude Code/claude' --desktop --resume ${ID}`);
  assert.equal(manualHandoffCommand("claude", ID), `claude --desktop --resume ${ID}`);

  const noTerminal = await showInClaudeDesktop({ binary: "claude", cwd: tmpdir(), sessionId: ID, platform: "darwin", scriptPath: "/no/such/script" });
  assert.equal(noTerminal.shown, false);
  assert.match(noTerminal.detail, /is not available to give the command a terminal/);
});
