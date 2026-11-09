import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import type { TurnFiles } from "../src/bridge-store.js";
import { CodexAppServerRunner } from "../src/codex-app-runner.js";
import { appServerArgs, threadParams, turnParams, turnSandboxPolicy, type AppTurnOptions } from "../src/codex-app-turn.js";
import { isProcessAlive } from "../src/process-info.js";
import { fakeCodex } from "./helpers/fakes.js";


test("an app-server turn states the folder, sandbox and approval policy at every level", () => {
  const options: AppTurnOptions = {
    codex: "codex", cwd: "/work/tree", sandbox: "workspace-write", outputPath: "/runs/o.json", schemaPath: "/runs/s.json",
    sessionId: null, model: "gpt-5.6-luna", effort: "low", title: "Bridge: fix login", config: ["-c", 'sandbox_mode="workspace-write"'],
  };
  assert.deepEqual(appServerArgs(options), ["app-server", "-c", 'sandbox_mode="workspace-write"']);
  assert.deepEqual(threadParams(options), { cwd: "/work/tree", sandbox: "workspace-write", approvalPolicy: "never", model: "gpt-5.6-luna" });
  assert.deepEqual(threadParams({ ...options, sessionId: "thread-7", model: null }), {
    threadId: "thread-7", cwd: "/work/tree", sandbox: "workspace-write", approvalPolicy: "never",
  });
  const turn = turnParams(options, "thread-7", "do the work", { type: "object" });
  assert.equal(turn.threadId, "thread-7");
  assert.equal(turn.approvalPolicy, "never");
  assert.equal(turn.effort, "low");
  assert.deepEqual(turn.input, [{ type: "text", text: "do the work", text_elements: [] }]);
  assert.deepEqual(turn.sandboxPolicy, { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeSlashTmp: false, excludeTmpdirEnvVar: false });
  assert.deepEqual(turnSandboxPolicy("read-only"), { type: "readOnly", networkAccess: false });
  assert.equal("effort" in turnParams({ ...options, effort: null }, "t", "p", {}), false, "no effort means the model's default");
});

test("the runner starts a listed Codex chat and resumes it with the same pins", { skip: process.platform === "win32" }, async () => {
  const fake = fakeCodex();
  const runner = new CodexAppServerRunner({ binary: fake.binary, dataDir: join(fake.dir, "runs"), timeoutMs: 20_000, extraConfig: ['model_verbosity="low"'] });
  const spawned: Array<{ pid: number | null; files: TurnFiles | null }> = [];
  const sessions: string[] = [];

  const first = await runner.run(
    { cwd: fake.dir, prompt: "hello world", sessionId: null, sandbox: "workspace-write", model: "gpt-5.6-luna", effort: "low", title: "Bridge: hello" },
    { onSpawn: (info) => spawned.push(info), onSession: (id) => sessions.push(id) },
  );
  assert.equal(first.sessionId, "fake-thread-1");
  assert.equal(first.response.status, "completed");
  assert.match(first.response.summary, /handled: hello world/, "the last message of this thread is the answer, not a sub-agent's");
  assert.deepEqual(sessions, ["fake-thread-1"]);

  const events = readFileSync(spawned[0]?.files?.eventsPath ?? "", "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(events[0], { type: "thread.started", thread_id: "fake-thread-1" }, "the session is announced the way codex exec announces it");
  assert.equal(events.some((event) => String(event.type).endsWith("delta")), false, "streaming fragments stay out of the log");
  assert.ok(events.some((event) => event.type === "turn/completed"));

  const calls = fake.calls();
  const argv = calls[0]?.argv as string[];
  assert.equal(argv[0], "app-server");
  const pinned = argv.lastIndexOf('sandbox_mode="workspace-write"');
  assert.ok(argv.indexOf('model_verbosity="low"') < pinned && argv.indexOf('model="gpt-5.6-luna"') < pinned, "safety values come last and win");
  assert.ok(argv.includes('approval_policy="never"'));
  assert.ok(argv.includes("sandbox_workspace_write.network_access=false"));
  const sent = (method: string) => calls.find((call) => call.method === method)?.params;
  assert.equal(sent("initialize").clientInfo.name, "claude-codex-bridge");
  assert.deepEqual(sent("thread/start"), { cwd: fake.dir, sandbox: "workspace-write", approvalPolicy: "never", model: "gpt-5.6-luna" });
  assert.deepEqual(sent("thread/name/set"), { threadId: "fake-thread-1", name: "Bridge: hello" });
  const turn = sent("turn/start");
  assert.equal(turn.effort, "low");
  assert.equal(turn.approvalPolicy, "never");
  assert.equal(turn.sandboxPolicy.networkAccess, false);
  assert.deepEqual(turn.outputSchema.required, ["status", "summary", "evidence", "question", "filesChanged", "tests", "suggestedChips"]);

  const resumed = await runner.run({ cwd: fake.dir, prompt: "continue please", sessionId: "fake-thread-1", sandbox: "read-only" });
  assert.equal(resumed.sessionId, "fake-thread-1");
  const later = fake.calls().slice(calls.length);
  assert.ok((later[0]?.argv as string[]).includes('sandbox_mode="read-only"'), "a resumed turn is pinned again");
  assert.deepEqual(later.find((call) => call.method === "thread/resume")?.params, { threadId: "fake-thread-1", cwd: fake.dir, sandbox: "read-only", approvalPolicy: "never" });
  assert.equal(later.some((call) => call.method === "thread/name/set"), false, "a resumed chat keeps its name");
  assert.deepEqual(later.find((call) => call.method === "turn/start")?.params.sandboxPolicy, { type: "readOnly", networkAccess: false });

  // Another bridge process can finish the turn from its files alone.
  assert.equal(runner.recover(spawned[0]?.files as TurnFiles, null).sessionId, "fake-thread-1");
});

test("a failed, crashed or stuck app-server turn is reported with its reason", { skip: process.platform === "win32" }, async () => {
  const fake = fakeCodex();
  const runner = new CodexAppServerRunner({ binary: fake.binary, dataDir: join(fake.dir, "runs"), timeoutMs: 1500, extraConfig: [] });

  await assert.rejects(
    runner.run({ cwd: fake.dir, prompt: "please [[fail]]", sessionId: null, sandbox: "read-only" }),
    /Codex exited 1: Codex turn failed: model refused/,
  );
  await assert.rejects(
    runner.run({ cwd: fake.dir, prompt: "[[crash]] now", sessionId: null, sandbox: "read-only" }),
    /Codex exited 1: Codex app-server exited with 7 before the turn finished: fake server lost its mind/,
  );

  const hanging: Array<{ pid: number | null }> = [];
  await assert.rejects(
    runner.run({ cwd: fake.dir, prompt: "[[hang]] forever", sessionId: null, sandbox: "read-only" }, { onSpawn: (info) => hanging.push(info) }),
    /timed out/,
  );
  const pid = hanging[0]?.pid ?? null;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && (await isProcessAlive(pid))) await sleep(100);
  assert.equal(await isProcessAlive(pid), false, "a timed-out turn's process group is stopped");
});
