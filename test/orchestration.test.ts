import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { BridgeStore, type TurnFiles } from "../src/bridge-store.js";
import {
  CodexCliRunner,
  GitWorkspaceManager,
  Orchestrator,
  buildCodexArgs,
  parseExtraCodexConfig,
  type CodexRunner,
  type CodexTurnRequest,
  type CodexTurnResponse,
  type PrepareInput,
  type PreparedWorkspace,
  type TurnHooks,
  type WorkspaceManager,
} from "../src/orchestrator.js";
import { isProcessAlive } from "../src/process-info.js";

function freshStore(): BridgeStore {
  const dir = mkdtempSync(join(tmpdir(), "claude-codex-orchestrator-"));
  return new BridgeStore(join(dir, "bridge.sqlite"));
}

class FakeWorkspace implements WorkspaceManager {
  changeSets: string[][] = [];
  async prepare(input: PrepareInput): Promise<PreparedWorkspace> {
    return {
      path: `${input.projectPath}/worktrees/${input.runId}`,
      branch: `bridge/${input.runId}`,
      baseCommit: "abc123",
      uncommitted: [],
      includedUncommitted: false,
      warnings: [],
    };
  }
  async changes(): Promise<string[]> {
    return this.changeSets.length > 1 ? (this.changeSets.shift() as string[]) : this.changeSets[0] ?? [];
  }
}

class FakeRunner implements CodexRunner {
  readonly turnTimeoutMs = 60_000;
  requests: CodexTurnRequest[] = [];
  responses: Array<CodexTurnResponse | Error> = [];
  gate: Promise<void> | null = null;

  async run(request: CodexTurnRequest, hooks?: TurnHooks) {
    this.requests.push(request);
    hooks?.onSpawn?.({ pid: null, started: null, files: null });
    if (this.gate) await this.gate;
    const next = this.responses.shift();
    if (!next) throw new Error("Missing fake response");
    if (next instanceof Error) throw next;
    return { sessionId: request.sessionId ?? "codex-session-1", response: next };
  }
}

const completed = (summary: string): CodexTurnResponse => ({
  status: "completed",
  summary,
  evidence: ["npm test: passed"],
  filesChanged: ["src/service.ts"],
  tests: ["npm test: passed"],
  suggestedChips: [],
});

async function eventually<T>(read: () => T | undefined | null | false, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await sleep(10);
  }
  throw new Error("condition not met in time");
}

test("orchestration run state and events survive reopening the database", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-codex-run-store-"));
  const dbPath = join(dir, "bridge.sqlite");
  const first = new BridgeStore(dbPath);
  first.createRun({
    id: "run-1",
    coordinatorAgent: "claude-main",
    projectPath: "/repo",
    worktreePath: "/repo/worktrees/run-1",
    threadId: "feature-x",
    task: "Implement feature X",
    status: "created",
    maxRounds: 4,
    sandboxMode: "read-only",
  });
  first.appendRunEvent("run-1", "created", { safe: true });
  first.updateRun("run-1", { status: "waiting_for_fable", round: 1, codexSessionId: "session-1" });
  first.close();

  const reopened = new BridgeStore(dbPath);
  const run = reopened.getRun("run-1");
  assert.equal(run?.status, "waiting_for_fable");
  assert.equal(run?.codexSessionId, "session-1");
  assert.equal(run?.round, 1);
  assert.equal(run?.sandboxMode, "read-only");
  assert.deepEqual(reopened.runEvents("run-1")[0]?.payload, { safe: true });
  reopened.close();
});

test("Codex asks the coordinator, resumes the same session and sandbox, and completes", async () => {
  const store = freshStore();
  const runner = new FakeRunner();
  runner.responses.push(
    {
      status: "needs_fable",
      summary: "Need architecture judgment",
      evidence: [],
      question: "Which boundary should own retries?",
      filesChanged: [],
      tests: [],
      suggestedChips: [],
    },
    completed("Implemented retry ownership in the service layer"),
  );
  const orchestrator = new Orchestrator(store, runner, new FakeWorkspace(), { deliveryDelayMs: 5, pollMs: 5 });

  const started = await orchestrator.start({
    coordinatorAgent: "claude-main",
    projectPath: "/repo",
    task: "Implement retries",
    threadId: "retry-work",
    useWorktree: true,
    maxRounds: 4,
  });
  assert.equal(started.status, "waiting_for_fable");
  assert.equal(started.question, "Which boundary should own retries?");
  assert.equal(started.sandbox, "workspace-write");

  const done = await orchestrator.continueWithFable(started.runId, "The service layer owns retries; keep transport adapters stateless.");
  assert.equal(done.status, "completed");
  assert.equal(done.codexSessionId, "codex-session-1");
  assert.equal(runner.requests[1]?.sessionId, "codex-session-1");
  assert.equal(runner.requests[1]?.sandbox, "workspace-write");
  assert.match(runner.requests[1]?.prompt ?? "", /service layer owns retries/);
  assert.equal(store.getRun(started.runId)?.status, "completed");

  // Results returned directly to the caller are not posted to the mailbox again.
  await sleep(40);
  assert.equal(store.inbox("claude-main").length, 0);
  orchestrator.close();
  store.close();
});

test("continuation is rejected unless Codex is waiting for the coordinator", async () => {
  const store = freshStore();
  const runner = new FakeRunner();
  runner.responses.push(completed("Already complete"));
  const orchestrator = new Orchestrator(store, runner, new FakeWorkspace());
  const run = await orchestrator.start({
    coordinatorAgent: "claude-main",
    projectPath: "/repo",
    task: "Inspect only",
    threadId: "inspect",
    useWorktree: false,
    maxRounds: 3,
  });
  await assert.rejects(orchestrator.continueWithFable(run.runId, "extra answer"), /not waiting for Fable/);
  orchestrator.close();
  store.close();
});

test("round limit blocks an infinite coordinator and Codex loop", async () => {
  const store = freshStore();
  const runner = new FakeRunner();
  runner.responses.push({
    status: "needs_fable",
    summary: "Still uncertain",
    evidence: [],
    question: "Need another judgment",
    filesChanged: [],
    tests: [],
    suggestedChips: [],
  });
  const orchestrator = new Orchestrator(store, runner, new FakeWorkspace());
  const started = await orchestrator.start({
    coordinatorAgent: "claude-main",
    projectPath: "/repo",
    task: "Bounded task",
    threadId: "bounded",
    useWorktree: false,
    maxRounds: 1,
  });
  const blocked = await orchestrator.continueWithFable(started.runId, "Answer once");
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.summary, /round limit/i);
  assert.equal(runner.requests.length, 1);
  orchestrator.close();
  store.close();
});

test("a slow Codex turn returns running_codex and later posts its result to the coordinator exactly once", async () => {
  const store = freshStore();
  const runner = new FakeRunner();
  let release!: () => void;
  runner.gate = new Promise<void>((resolve) => (release = resolve));
  runner.responses.push(completed("Background work finished"));
  const orchestrator = new Orchestrator(store, runner, new FakeWorkspace(), { deliveryDelayMs: 5, pollMs: 5 });

  const started = await orchestrator.start({
    coordinatorAgent: "claude-main",
    projectPath: "/repo",
    task: "Long task",
    threadId: "long-task",
    useWorktree: true,
    maxRounds: 2,
    waitMs: 20,
  });
  assert.equal(started.status, "running_codex");
  assert.match(started.next ?? "", /mailbox/);
  assert.deepEqual(started.filesChanged, []);

  release();
  const [message] = await eventually(() => {
    const inbox = store.inbox("claude-main");
    return inbox.length ? inbox : null;
  });
  assert.equal(message.fromAgent, "bridge");
  assert.equal(message.threadId, "long-task");
  assert.match(message.body, new RegExp(started.runId));
  assert.match(message.body, /completed/);
  assert.match(message.body, /Background work finished/);

  const waited = await orchestrator.wait(started.runId, 100);
  assert.equal(waited.status, "completed");
  assert.match(waited.next ?? "", /also posted/);
  await sleep(40);
  assert.equal(store.inbox("claude-main").length, 1);
  orchestrator.close();
  store.close();
});

test("read-only reviews use a read-only sandbox and flag any workspace change", async () => {
  const store = freshStore();
  const runner = new FakeRunner();
  runner.responses.push(completed("No substantive findings"));
  const workspace = new FakeWorkspace();
  workspace.changeSets = [[], ["?? unexpected.txt"]];
  const orchestrator = new Orchestrator(store, runner, workspace);
  const result = await orchestrator.start({
    coordinatorAgent: "claude-main",
    projectPath: "/repo",
    task: "Review only",
    threadId: "review",
    useWorktree: false,
    sandbox: "read-only",
    maxRounds: 1,
  });
  assert.equal(runner.requests[0]?.sandbox, "read-only");
  assert.match(runner.requests[0]?.prompt ?? "", /read-only/);
  assert.equal(result.sandbox, "read-only");
  assert.deepEqual(result.observedChanges, ["?? unexpected.txt"]);
  assert.ok(result.warnings.some((warning) => /changed during a read-only run/.test(warning)));
  orchestrator.close();
  store.close();
});

test("a failed background turn is recorded and still reaches the coordinator", async () => {
  const store = freshStore();
  const runner = new FakeRunner();
  let release!: () => void;
  runner.gate = new Promise<void>((resolve) => (release = resolve));
  runner.responses.push(new Error("Codex exited 1: sandbox denied"));
  const orchestrator = new Orchestrator(store, runner, new FakeWorkspace(), { deliveryDelayMs: 5, pollMs: 5 });
  const started = await orchestrator.start({
    coordinatorAgent: "claude-main",
    projectPath: "/repo",
    task: "Will fail",
    threadId: "fails",
    useWorktree: true,
    maxRounds: 2,
    waitMs: 0,
  });
  assert.equal(started.status, "running_codex");
  release();
  const [message] = await eventually(() => {
    const inbox = store.inbox("claude-main");
    return inbox.length ? inbox : null;
  });
  assert.match(message.body, /failed/);
  assert.match(message.body, /sandbox denied/);
  orchestrator.close();
  store.close();
});

test("Codex arguments pin the sandbox on every turn, including resumed ones", () => {
  const files = { outputPath: "/runs/out.json", schemaPath: "/runs/schema.json" };
  const start = buildCodexArgs({ sessionId: null, sandbox: "workspace-write", ...files });
  assert.deepEqual(start.slice(0, 3), ["exec", "--sandbox", "workspace-write"]);
  assert.ok(start.includes('sandbox_mode="workspace-write"'));
  assert.ok(start.includes("sandbox_workspace_write.network_access=false"));
  assert.ok(start.includes('approval_policy="never"'));
  assert.equal(start.at(-1), "-");

  const resume = buildCodexArgs({ sessionId: "thread-1", sandbox: "workspace-write", ...files });
  assert.deepEqual(resume.slice(0, 2), ["exec", "resume"]);
  assert.ok(resume.includes('sandbox_mode="workspace-write"'), "resume must not inherit the config default");
  assert.equal(resume.includes("--sandbox"), false, "codex exec resume has no --sandbox flag");
  assert.deepEqual(resume.slice(-2), ["thread-1", "-"]);

  const review = buildCodexArgs({ sessionId: "thread-2", sandbox: "read-only", ...files });
  assert.ok(review.includes('sandbox_mode="read-only"'));
  assert.equal(review.some((arg) => arg.includes("network_access")), false);
});

test("worker config overrides can tune the model but never the safety boundary", () => {
  const extra = parseExtraCodexConfig('model_reasoning_effort="medium"; sandbox_mode="danger-full-access"\napproval_policy="on-request";sandbox_workspace_write.network_access=true; bad-entry');
  assert.deepEqual(extra, ['model_reasoning_effort="medium"']);
  const args = buildCodexArgs({ sessionId: null, sandbox: "read-only", outputPath: "/o", schemaPath: "/s", extraConfig: extra });
  const pinned = args.lastIndexOf('sandbox_mode="read-only"');
  assert.ok(args.indexOf('model_reasoning_effort="medium"') < pinned, "pinned values come last and win");
  assert.equal(parseExtraCodexConfig(undefined).length, 0);
});

const FAKE_CODEX = `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const output = args[args.indexOf("-o") + 1];
let prompt = "";
process.stdin.on("data", (chunk) => (prompt += chunk));
process.stdin.on("end", () => {
  writeFileSync(output + ".argv.json", JSON.stringify(args));
  if (prompt.includes("hang")) { setTimeout(() => {}, 60000); return; }
  if (prompt.includes("fail")) { process.stderr.write("boom from fake codex"); process.exit(3); }
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: args[1] === "resume" ? args[args.length - 2] : "fake-thread" }) + "\\n");
  writeFileSync(output, JSON.stringify({ status: "completed", summary: "handled: " + prompt.slice(0, 20), evidence: [], question: "", filesChanged: [], tests: [], suggestedChips: [] }));
});
`;

test("the Codex runner drives a detached process through files and recovers from them", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "fake-codex-"));
  const binary = join(dir, "codex");
  writeFileSync(binary, FAKE_CODEX, { mode: 0o755 });
  // ESM package scope must not apply to the fake binary.
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "commonjs" }));
  chmodSync(binary, 0o755);
  const runner = new CodexCliRunner({ binary, dataDir: join(dir, "runs"), timeoutMs: 1500 });

  const spawned: Array<{ pid: number | null; files: TurnFiles | null }> = [];
  const first = await runner.run({ cwd: dir, prompt: "hello world", sessionId: null, sandbox: "workspace-write" }, {
    onSpawn: (info) => spawned.push(info),
  });
  assert.equal(first.sessionId, "fake-thread");
  assert.match(first.response.summary, /handled: hello world/);
  assert.equal(typeof spawned[0]?.pid, "number");

  const resumed = await runner.run(
    { cwd: dir, prompt: "continue", sessionId: "fake-thread", sandbox: "workspace-write" },
    { onSpawn: (info) => spawned.push(info) },
  );
  assert.equal(resumed.sessionId, "fake-thread");
  const argv = JSON.parse(readFileSync(`${spawned[1]?.files?.outputPath}.argv.json`, "utf8")) as string[];
  assert.deepEqual(argv.slice(0, 2), ["exec", "resume"]);
  assert.ok(argv.includes('sandbox_mode="workspace-write"'));

  // Another process can finish the turn from its files alone.
  const recovered = runner.recover(spawned[0]?.files as TurnFiles, null);
  assert.equal(recovered.sessionId, "fake-thread");

  await assert.rejects(
    runner.run({ cwd: dir, prompt: "please fail", sessionId: null, sandbox: "read-only" }),
    /Codex exited 3: boom from fake codex/,
  );

  const hanging: Array<{ pid: number | null }> = [];
  await assert.rejects(
    runner.run({ cwd: dir, prompt: "hang forever", sessionId: null, sandbox: "workspace-write" }, {
      onSpawn: (info) => hanging.push(info),
    }),
    /timed out/,
  );
  const pid = hanging[0]?.pid ?? null;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && (await isProcessAlive(pid))) await sleep(100);
  assert.equal(await isProcessAlive(pid), false, "a timed-out Codex process group is stopped");
});

test("orphaned runs are adopted and finished from their files, or marked interrupted", async () => {
  const store = freshStore();
  const dir = mkdtempSync(join(tmpdir(), "orphan-run-"));
  const runner = new CodexCliRunner({ binary: "unused", dataDir: join(dir, "runs") });
  const orchestrator = new Orchestrator(store, runner, new FakeWorkspace(), { deliveryDelayMs: 5, pollMs: 5 });
  const deadPid = 9_999_999;

  const makeRun = (id: string, withOutput: boolean) => {
    const files = {
      outputPath: join(dir, `${id}.json`),
      eventsPath: join(dir, `${id}.events.jsonl`),
      stderrPath: join(dir, `${id}.stderr.log`),
    };
    writeFileSync(files.eventsPath, `${JSON.stringify({ type: "thread.started", thread_id: `session-${id}` })}\n`);
    if (withOutput) writeFileSync(files.outputPath, JSON.stringify(completed("Finished while nobody watched")));
    store.createRun({
      id,
      coordinatorAgent: "claude-main",
      projectPath: "/repo",
      worktreePath: dir,
      threadId: `thread-${id}`,
      task: "Orphaned work",
      status: "created",
      maxRounds: 3,
      ownerPid: deadPid,
    });
    store.updateRun(id, { status: "running_codex", round: 1, turnFiles: files, childPid: null });
  };
  makeRun("11111111-1111-4111-8111-111111111111", true);
  makeRun("22222222-2222-4222-8222-222222222222", false);

  const outcome = await orchestrator.reconcile();
  assert.equal(outcome.adopted, 2);
  const recovered = await eventually(() => {
    const run = store.getRun("11111111-1111-4111-8111-111111111111");
    return run?.status === "completed" ? run : null;
  });
  assert.equal(recovered.codexSessionId, "session-11111111-1111-4111-8111-111111111111");
  const interrupted = await eventually(() => {
    const run = store.getRun("22222222-2222-4222-8222-222222222222");
    return run?.status === "failed" ? run : null;
  });
  assert.match(String(interrupted.latestResponse?.summary), /interrupted/);
  const messages = await eventually(() => {
    const inbox = store.inbox("claude-main");
    return inbox.length === 2 ? inbox : null;
  });
  assert.ok(messages.every((message) => message.fromAgent === "bridge"));
  assert.ok(store.runEvents("11111111-1111-4111-8111-111111111111").some((event) => event.type === "adopted"));

  // A second pass finds nothing left to do.
  assert.deepEqual(await orchestrator.reconcile(), { adopted: 0, delivered: 0 });
  orchestrator.close();
  store.close();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=Bridge Test", "-c", "user.email=bridge@test.invalid", ...args], {
    encoding: "utf8",
  }).trim();
}

test("worktrees live outside the repository and can carry uncommitted changes", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "bridge-git-")));
  const repo = join(base, "repo");
  mkdirSync(join(repo, "sub"), { recursive: true });
  git(base, "init", "-q", repo);
  git(repo, "config", "core.autocrlf", "false");
  writeFileSync(join(repo, "tracked.txt"), "committed\n");
  writeFileSync(join(repo, "sub", "keep.txt"), "sub\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "initial");
  const head = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "tracked.txt"), "work in progress\n");
  writeFileSync(join(repo, "new-file.txt"), "untracked\n");

  const root = join(base, "worktrees");
  const manager = new GitWorkspaceManager(root);
  const plain = await manager.prepare({ projectPath: repo, useWorktree: true, runId: "aaaaaaaa-0000-4000-8000-000000000000", threadId: "Feature X!" });
  assert.ok(plain.path.startsWith(root), "worktree must be outside the repository");
  assert.equal(plain.branch, "bridge/feature-x-aaaaaaaa");
  assert.equal(plain.baseCommit, head);
  assert.equal(plain.uncommitted.length, 2);
  assert.match(plain.warnings[0] ?? "", /2 uncommitted change/);
  assert.equal(readFileSync(join(plain.path, "tracked.txt"), "utf8"), "committed\n");
  assert.equal(existsSync(join(plain.path, "new-file.txt")), false);

  const carried = await manager.prepare({
    projectPath: repo,
    useWorktree: true,
    runId: "bbbbbbbb-0000-4000-8000-000000000000",
    threadId: "carry",
    includeUncommitted: true,
  });
  assert.equal(carried.includedUncommitted, true);
  assert.deepEqual(carried.warnings, []);
  assert.equal(readFileSync(join(carried.path, "tracked.txt"), "utf8"), "work in progress\n");
  assert.equal(readFileSync(join(carried.path, "new-file.txt"), "utf8"), "untracked\n");
  assert.equal((await manager.changes(carried.path))?.length, 2);

  // The main checkout only reports the user's own two changes.
  assert.equal((await manager.changes(repo))?.length, 2);

  const nested = await manager.prepare({ projectPath: join(repo, "sub"), useWorktree: true, runId: "cccccccc-0000-4000-8000-000000000000", threadId: "nested" });
  assert.ok(nested.path.endsWith(join("nested-cccccccc", "sub")));
  assert.equal(readFileSync(join(nested.path, "keep.txt"), "utf8"), "sub\n");
});
