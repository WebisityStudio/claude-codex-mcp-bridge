import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BridgeStore } from "../src/bridge-store.js";
import {
  Orchestrator,
  type CodexRunner,
  type CodexTurnResponse,
  type WorkspaceManager,
} from "../src/orchestrator.js";

function freshStore(): BridgeStore {
  const dir = mkdtempSync(join(tmpdir(), "claude-codex-orchestrator-"));
  return new BridgeStore(join(dir, "bridge.sqlite"));
}

class FakeWorkspace implements WorkspaceManager {
  async prepare(projectPath: string, _useWorktree: boolean, runId: string) {
    return { path: `${projectPath}/worktrees/${runId}`, branch: `bridge/${runId}` };
  }
}

class FakeRunner implements CodexRunner {
  starts: Array<{ cwd: string; prompt: string }> = [];
  resumes: Array<{ cwd: string; sessionId: string; prompt: string }> = [];
  startResponses: CodexTurnResponse[] = [];
  resumeResponses: CodexTurnResponse[] = [];

  async start(input: { cwd: string; prompt: string }) {
    this.starts.push(input);
    const response = this.startResponses.shift();
    if (!response) throw new Error("Missing fake start response");
    return { sessionId: "codex-session-1", response };
  }

  async resume(input: { cwd: string; sessionId: string; prompt: string }) {
    this.resumes.push(input);
    const response = this.resumeResponses.shift();
    if (!response) throw new Error("Missing fake resume response");
    return { sessionId: input.sessionId, response };
  }
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
  });
  first.appendRunEvent("run-1", "created", { safe: true });
  first.updateRun("run-1", { status: "waiting_for_fable", round: 1, codexSessionId: "session-1" });
  first.close();

  const reopened = new BridgeStore(dbPath);
  const run = reopened.getRun("run-1");
  assert.equal(run?.status, "waiting_for_fable");
  assert.equal(run?.codexSessionId, "session-1");
  assert.equal(run?.round, 1);
  assert.deepEqual(reopened.runEvents("run-1")[0]?.payload, { safe: true });
  reopened.close();
});

test("Codex can ask Fable for help and resume the same session to completion", async () => {
  const store = freshStore();
  const runner = new FakeRunner();
  runner.startResponses.push({
    status: "needs_fable",
    summary: "Need architecture judgment",
    evidence: [],
    question: "Which boundary should own retries?",
    filesChanged: [],
    tests: [],
    suggestedChips: [],
  });
  runner.resumeResponses.push({
    status: "completed",
    summary: "Implemented retry ownership in the service layer",
    evidence: ["npm test: passed"],
    filesChanged: ["src/service.ts"],
    tests: ["npm test: passed"],
    suggestedChips: [],
  });
  const orchestrator = new Orchestrator(store, runner, new FakeWorkspace());

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

  const completed = await orchestrator.continueWithFable(
    started.runId,
    "The service layer owns retries; keep transport adapters stateless.",
  );
  assert.equal(completed.status, "completed");
  assert.equal(completed.codexSessionId, "codex-session-1");
  assert.equal(runner.resumes[0]?.sessionId, "codex-session-1");
  assert.match(runner.resumes[0]?.prompt ?? "", /service layer owns retries/);
  assert.equal(store.getRun(started.runId)?.status, "completed");
  store.close();
});

test("continuation is rejected unless Codex is waiting for Fable", async () => {
  const store = freshStore();
  const runner = new FakeRunner();
  runner.startResponses.push({
    status: "completed",
    summary: "Already complete",
    evidence: [],
    filesChanged: [],
    tests: [],
    suggestedChips: [],
  });
  const orchestrator = new Orchestrator(store, runner, new FakeWorkspace());
  const run = await orchestrator.start({
    coordinatorAgent: "claude-main",
    projectPath: "/repo",
    task: "Inspect only",
    threadId: "inspect",
    useWorktree: false,
    maxRounds: 3,
  });

  await assert.rejects(
    orchestrator.continueWithFable(run.runId, "extra answer"),
    /not waiting for Fable/,
  );
  store.close();
});

test("round limit blocks an infinite Fable and Codex loop", async () => {
  const store = freshStore();
  const runner = new FakeRunner();
  const needsHelp: CodexTurnResponse = {
    status: "needs_fable",
    summary: "Still uncertain",
    evidence: [],
    question: "Need another judgment",
    filesChanged: [],
    tests: [],
    suggestedChips: [],
  };
  runner.startResponses.push(needsHelp);
  runner.resumeResponses.push(needsHelp);
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
  assert.equal(store.getRun(started.runId)?.status, "blocked");
  store.close();
});
