import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { BridgeStore } from "../src/bridge-store.js";
import {
  Orchestrator,
  runResultMessage,
  type CodexRunner,
  type CodexTurnRequest,
  type CodexTurnResponse,
  type DesktopHandoffResult,
  type PrepareInput,
  type PreparedWorkspace,
  type TurnOutcome,
  type WorkspaceManager,
} from "../src/orchestrator.js";
import { fakeClaude, fakeCodex } from "./helpers/fakes.js";

// Worker chats in either app: the caller's choices travel with the run, the
// owner's policy caps them, and a finished Claude chat can be handed to the
// desktop app.

class Workspace implements WorkspaceManager {
  changeSets: string[][] = [];
  async prepare(input: PrepareInput): Promise<PreparedWorkspace> {
    return { path: `${input.projectPath}/work`, branch: null, baseCommit: "abc123", uncommitted: [], includedUncommitted: true, warnings: [] };
  }
  async changes(): Promise<string[]> {
    return this.changeSets.length > 1 ? (this.changeSets.shift() as string[]) : this.changeSets[0] ?? [];
  }
}

class Runner implements CodexRunner {
  readonly turnTimeoutMs = 60_000;
  requests: CodexTurnRequest[] = [];
  responses: Array<Partial<TurnOutcome> & { response: CodexTurnResponse }> = [];
  constructor(private readonly session: string, readonly listedInApp?: boolean) {}
  async run(request: CodexTurnRequest): Promise<TurnOutcome> {
    this.requests.push(request);
    const next = this.responses.shift();
    if (!next) throw new Error("Missing fake response");
    return { sessionId: request.sessionId ?? this.session, ...next };
  }
}

const answer = (status: CodexTurnResponse["status"], summary: string, question?: string): CodexTurnResponse => ({
  status, summary, evidence: [], filesChanged: [], tests: [], suggestedChips: [], ...(question ? { question } : {}),
});

const base = { coordinatorAgent: "lead", projectPath: "/repo", task: "Do the work", threadId: "task-1", useWorktree: true, maxRounds: 3 };

test("a Claude worker keeps its choices across rounds and is handed over only once it has finished", async () => {
  const store = new BridgeStore(":memory:");
  const codex = new Runner("codex-session");
  const claude = new Runner("claude-session");
  const handoffs: Array<{ cwd: string; sessionId: string }> = [];
  const orchestrator = new Orchestrator(store, codex, new Workspace(), {
    claudeRunner: claude,
    showInDesktop: async (chat) => {
      handoffs.push(chat);
      return { shown: true, detail: "Opened in the Claude desktop app.", manualCommand: "claude --desktop --resume claude-session" };
    },
  });
  try {
    claude.responses.push({ response: answer("needs_fable", "Need a decision", "Option A or B?") });
    const asked = await orchestrator.start({
      ...base, worker: "claude", model: "haiku", effort: "low", permissionMode: "acceptEdits", showInDesktop: true, title: "Bridge: do the work",
    });
    assert.equal(asked.status, "waiting_for_fable");
    assert.deepEqual([asked.worker, asked.model, asked.effort, asked.permissionMode], ["claude", "haiku", "low", "acceptEdits"]);
    assert.equal(asked.desktop, undefined);
    assert.deepEqual(handoffs, [], "a chat still waiting for an answer stays with the bridge");
    assert.equal(codex.requests.length, 0, "the Codex runner is not involved");
    const first = claude.requests[0];
    assert.deepEqual(
      [first.sessionId, first.sandbox, first.model, first.effort, first.permissionMode, first.title],
      [null, "workspace-write", "haiku", "low", "acceptEdits", "Bridge: do the work"],
    );
    assert.match(first.prompt, /You are a Claude Code worker started by another agent session/);
    assert.equal(/Network access is disabled/.test(first.prompt), false, "the Codex sandbox claim is not made for Claude");

    claude.responses.push({ response: answer("completed", "All done"), warnings: ["Claude's permission mode refused 1 tool call(s) (Bash)."] });
    const done = await orchestrator.continueWithFable(asked.runId, "Option B");
    assert.equal(done.status, "completed");
    const second = claude.requests[1];
    assert.deepEqual(
      [second.sessionId, second.model, second.effort, second.permissionMode],
      ["claude-session", "haiku", "low", "acceptEdits"],
      "the same chat and the same choices",
    );
    assert.deepEqual(handoffs, [{ cwd: "/repo/work", sessionId: "claude-session" }]);
    assert.equal(done.desktop?.shown, true);
    assert.ok(done.warnings.some((warning) => /refused 1 tool call/.test(warning)), "what the runner noticed reaches the caller");

    const message = runResultMessage(done, "task-1");
    assert.match(message, /^Claude run /);
    assert.match(message, /Files changed \(reported by Claude\)/);
    assert.match(message, /Permission mode: acceptEdits/);
    assert.match(message, /The chat was opened in the Claude desktop app\./);
    assert.match(runResultMessage(asked, "task-1"), /Claude asks: Option A or B\?[\s\S]*bridge_continue_run/);
  } finally {
    orchestrator.close();
    store.close();
  }
});

test("read-only Claude modes are watched like a read-only sandbox, and a failed hand-off says what to run", async () => {
  const store = new BridgeStore(":memory:");
  const claude = new Runner("claude-session");
  const workspace = new Workspace();
  workspace.changeSets = [[], ["?? surprise.txt"]];
  const refused: DesktopHandoffResult = { shown: false, detail: "it did not answer in time", manualCommand: "claude --desktop --resume claude-session" };
  const orchestrator = new Orchestrator(store, new Runner("codex-session"), workspace, { claudeRunner: claude, showInDesktop: async () => refused });
  try {
    claude.responses.push({ response: answer("completed", "Reviewed") });
    const result = await orchestrator.start({ ...base, worker: "claude", permissionMode: "plan", showInDesktop: true });
    assert.equal(claude.requests[0].sandbox, "read-only");
    assert.match(claude.requests[0].prompt, /This chat cannot change files/);
    assert.equal(result.sandbox, "read-only");
    assert.ok(result.warnings.some((warning) => /changed during a read-only run/.test(warning)));
    assert.deepEqual(result.desktop, refused);
    assert.match(runResultMessage(result, "task-1"), /was not opened in the Claude desktop app \(it did not answer in time\)\. In a terminal in the workspace: claude --desktop --resume claude-session/);

    claude.responses.push({ response: answer("completed", "No hand-off asked") });
    const quiet = await orchestrator.start({ ...base, threadId: "task-2", worker: "claude", permissionMode: "manual" });
    assert.equal(quiet.desktop, undefined, "nothing is opened unless the policy check allowed it");
    assert.equal(claude.requests[1].sandbox, "read-only");
  } finally {
    orchestrator.close();
    store.close();
  }
});

test("Codex workers carry the chosen model and effort, and say how to open a listed chat", async () => {
  const store = new BridgeStore(":memory:");
  const listed = new Runner("thread-42", true);
  const orchestrator = new Orchestrator(store, listed, new Workspace());
  try {
    listed.responses.push({ response: answer("completed", "Implemented") });
    const result = await orchestrator.start({ ...base, model: "gpt-5.6-luna", effort: "medium", sandbox: "read-only", title: "Bridge: implement" });
    assert.deepEqual([result.worker, result.model, result.effort, result.sandbox], ["codex", "gpt-5.6-luna", "medium", "read-only"]);
    assert.equal(result.permissionMode, undefined);
    assert.equal(result.appLink, "codex://threads/thread-42");
    const request = listed.requests[0];
    assert.deepEqual([request.model, request.effort, request.sandbox, request.title, request.permissionMode], ["gpt-5.6-luna", "medium", "read-only", "Bridge: implement", null]);
    const message = runResultMessage(result, "task-1");
    assert.match(message, /^Codex run /);
    assert.match(message, /Sandbox: read-only\./);
    assert.match(message, /codex:\/\/threads\/thread-42 opens it/);
  } finally {
    orchestrator.close();
    store.close();
  }

  const plainStore = new BridgeStore(":memory:");
  const unlisted = new Runner("exec-session");
  const plain = new Orchestrator(plainStore, unlisted, new Workspace());
  try {
    unlisted.responses.push({ response: answer("completed", "Implemented") });
    const result = await plain.start(base);
    assert.equal(result.appLink, undefined, "codex exec sessions are not in the app's list");
    assert.deepEqual([result.worker, result.model], ["codex", undefined]);
    await assert.rejects(plain.start({ ...base, threadId: "task-9", worker: "claude" }), /not set up to run Claude workers/);
    assert.deepEqual(plainStore.runCounts(), { completed: 1 }, "a refused worker leaves no run behind");
    assert.equal(plainStore.countRunsSince(new Date(Date.now() - 60_000).toISOString()), 1);
    assert.equal(plainStore.countRunsSince(new Date(Date.now() + 60_000).toISOString()), 0);
  } finally {
    plain.close();
    plainStore.close();
  }
});

// --- end to end through the MCP server, with stand-in CLIs ---

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function throwawayRepo(base: string): string {
  const repo = join(base, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "bridge-test@example.invalid");
  git("config", "user.name", "Bridge Test");
  writeFileSync(join(repo, "tracked.txt"), "committed\n");
  git("add", ".");
  git("commit", "-q", "-m", "initial");
  return repo;
}

type Reply = { isError: boolean; text: string; payload: Record<string, any> };

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<Reply> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "";
  let payload: Record<string, any> = {};
  try { payload = JSON.parse(text) as Record<string, any>; } catch { /* an error message */ }
  return { isError: result.isError === true, text, payload };
}

test("ask_claude and ask_codex start worker chats with the caller's choices inside the owner's ceiling", { skip: process.platform === "win32" }, async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "bridge-workers-")));
  const repo = throwawayRepo(base);
  const claude = fakeClaude();
  const codex = fakeCodex();
  const policyPath = join(base, "policy.json");
  writeFileSync(policyPath, JSON.stringify({ maxStartsPerHour: 5, claude: { maxEffort: "medium" }, codex: { allowedModels: ["gpt-5.6-luna"] } }));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/server.ts"],
    cwd: projectRoot,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: base, // A throwaway home: nothing here can reach a real app or account.
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      BRIDGE_DB_PATH: join(base, "bridge.sqlite"),
      BRIDGE_BACKUPS: "0",
      XDG_DATA_HOME: join(base, "data"),
      BRIDGE_WORKTREE_ROOT: join(base, "worktrees"),
      BRIDGE_POLICY_PATH: policyPath,
      CLAUDE_BIN: claude.binary,
      CODEX_BIN: codex.binary,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "workers", version: "1.0.0" });
  await client.connect(transport);
  try {
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of ["ask_claude", "bridge_continue_run", "bridge_continue_codex", "ask_codex"]) assert.ok(tools.includes(name), name);

    // 1. A read-only Claude chat in the real checkout.
    const review = await callTool(client, "ask_claude", {
      projectPath: repo, request: "Check tracked.txt for problems", model: "haiku", effort: "low", permissionMode: "plan", coordinatorAgent: "lead",
    });
    assert.equal(review.isError, false, review.text);
    assert.deepEqual(
      [review.payload.status, review.payload.worker, review.payload.model, review.payload.effort, review.payload.permissionMode, review.payload.sandbox],
      ["completed", "claude", "haiku", "low", "plan", "read-only"],
    );
    assert.equal(realpathSync(review.payload.worktreePath), repo, "read-only modes read the real checkout");
    assert.equal(review.payload.desktop, undefined);
    const reviewCall = claude.calls(repo)[0];
    assert.equal(reviewCall[reviewCall.indexOf("--permission-mode") + 1], "plan");
    assert.equal(reviewCall[reviewCall.indexOf("--model") + 1], "haiku");
    assert.equal(reviewCall[reviewCall.indexOf("--name") + 1], "Bridge: Check tracked.txt for problems");

    // 2. An editing Claude chat: isolated worktree, a question, an answer, then the desktop hand-off.
    const asked = await callTool(client, "ask_claude", {
      projectPath: repo, request: "Change the file, but first [[ask]] which wording", showInDesktop: true, coordinatorAgent: "lead",
    });
    assert.equal(asked.isError, false, asked.text);
    assert.deepEqual([asked.payload.status, asked.payload.permissionMode, asked.payload.question], ["waiting_for_fable", "acceptEdits", "Which option?"]);
    assert.notEqual(realpathSync(asked.payload.worktreePath), repo, "editing modes work in an isolated worktree");
    assert.ok(existsSync(join(asked.payload.worktreePath, "tracked.txt")));
    assert.equal(asked.payload.desktop, undefined);
    const finished = await callTool(client, "bridge_continue_run", { runId: asked.payload.runId, answer: "Use the second wording" });
    assert.equal(finished.isError, false, finished.text);
    assert.equal(finished.payload.status, "completed");
    assert.equal(finished.payload.desktop.shown, process.platform === "darwin", finished.payload.desktop.detail);
    assert.match(finished.payload.desktop.manualCommand, /--desktop --resume/);
    const worktreeCalls = claude.calls(asked.payload.worktreePath);
    assert.ok(worktreeCalls[1].includes("--resume"), "the answer resumes the same chat");

    // 3. Above the ceiling: refused, with the limit named, and nothing started.
    const tooMuch = await callTool(client, "ask_claude", { projectPath: repo, request: "Think very hard", effort: "high", permissionMode: "plan" });
    assert.equal(tooMuch.isError, true);
    assert.match(tooMuch.text, /Reasoning effort "high" is higher than Claude workers may use \(up to "medium"\)/);
    assert.match(tooMuch.text, /a tool call cannot change it/);
    const autonomy = await callTool(client, "ask_claude", { projectPath: repo, request: "Do anything", permissionMode: "auto" });
    assert.match(autonomy.text, /more autonomy than Claude workers may have \(up to "acceptEdits"\)/);
    const wrongModel = await callTool(client, "ask_codex", { projectPath: repo, request: "Use the big model", model: "gpt-6.1-sol" });
    assert.match(wrongModel.text, /Codex workers may use only these models: gpt-5\.6-luna/);

    // 4. A Codex chat through app-server, listed by the app.
    const built = await callTool(client, "ask_codex", {
      projectPath: repo, request: "Implement the small change", model: "gpt-5.6-luna", reasoningEffort: "low", sandbox: "read-only", coordinatorAgent: "lead",
    });
    assert.equal(built.isError, false, built.text);
    assert.deepEqual(
      [built.payload.status, built.payload.worker, built.payload.model, built.payload.effort, built.payload.sandbox, built.payload.appLink],
      ["completed", "codex", "gpt-5.6-luna", "low", "read-only", "codex://threads/fake-thread-1"],
    );
    const sent = codex.calls(built.payload.worktreePath).filter((call) => call.method);
    assert.equal(sent.find((call) => call.method === "thread/name/set")?.params.name, "Bridge: Implement the small change");
    assert.equal(sent.find((call) => call.method === "turn/start")?.params.effort, "low");

    // 5. The hourly limit counts every worker chat this mailbox has started.
    const fourth = await callTool(client, "review_with_codex", { projectPath: repo, focus: "anything", model: "gpt-5.6-luna" });
    assert.equal(fourth.isError, false, fourth.text);
    const fifth = await callTool(client, "ask_claude", { projectPath: repo, request: "One more", permissionMode: "manual" });
    assert.equal(fifth.isError, false, fifth.text);
    const sixth = await callTool(client, "ask_claude", { projectPath: repo, request: "One too many", permissionMode: "manual" });
    assert.equal(sixth.isError, true);
    assert.match(sixth.text, /5 worker chats were started through this bridge in the last hour \(limit 5\)/);

    // A broken policy file stops every start instead of falling back to the defaults.
    writeFileSync(policyPath, "{ not json");
    const broken = await callTool(client, "ask_codex", { projectPath: repo, request: "Anything" });
    assert.equal(broken.isError, true);
    assert.match(broken.text, /policy file .* is not valid/);
    await sleep(50);
  } finally {
    await client.close();
  }
});
