// Live smoke test against the real Codex CLI. Everything bridge-side is
// isolated: a throwaway git repository, mailbox, run directory and worktree
// root. Only Codex's own login and session history in ~/.codex are used.
//
//   npm run smoke:orchestrator
//   BRIDGE_CODEX_CONFIG='model_reasoning_effort="low"' npm run smoke:orchestrator
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const work = realpathSync(mkdtempSync(join(tmpdir(), "bridge-live-smoke-")));
const repo = join(work, "repo");
execFileSync("git", ["init", "-q", repo]);
writeFileSync(join(repo, "README.md"), "# Smoke test\n\nThe answer to the smoke question is 42.\n");
execFileSync("git", ["-C", repo, "-c", "user.name=Smoke", "-c", "user.email=smoke@test.invalid", "add", "."]);
execFileSync("git", ["-C", repo, "-c", "user.name=Smoke", "-c", "user.email=smoke@test.invalid", "commit", "-q", "-m", "init"]);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", "src/server.ts"],
  cwd: root,
  env: {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? homedir(),
    USER: process.env.USER ?? "",
    XDG_DATA_HOME: join(work, "data"),
    BRIDGE_DB_PATH: join(work, "bridge.sqlite"),
    BRIDGE_BACKUPS: "0",
    ...(process.env.CODEX_BIN ? { CODEX_BIN: process.env.CODEX_BIN } : {}),
    ...(process.env.BRIDGE_CODEX_CONFIG ? { BRIDGE_CODEX_CONFIG: process.env.BRIDGE_CODEX_CONFIG } : {}),
  },
  stderr: "pipe",
});
const client = new Client({ name: "orchestrator-live-smoke", version: "1.0.0" });
await client.connect(transport);

type Result = Record<string, unknown> & { status: string; runId: string };

async function call(name: string, args: Record<string, unknown>): Promise<Result> {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 10 * 60 * 1000 });
  const item = (response.content as Array<{ type: string; text?: string }>)[0];
  if (response.isError || !item?.text) throw new Error(item?.text ?? "Empty MCP result");
  return JSON.parse(item.text) as Result;
}

async function settle(result: Result): Promise<Result> {
  while (result.status === "running_codex") {
    result = await call("bridge_orchestration_wait", { runId: result.runId, timeoutSeconds: 285 });
  }
  return result;
}

/** Sandbox policy of every turn in the Codex session, from Codex's own rollout. */
function sandboxPolicies(sessionId: string): string[] {
  const sessions = join(homedir(), ".codex", "sessions");
  const stack = [sessions];
  while (stack.length) {
    const directory = stack.pop() as string;
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) stack.push(path);
      else if (name.includes(sessionId) && name.endsWith(".jsonl")) {
        return [...readFileSync(path, "utf8").matchAll(/"sandbox_policy":\{"type":"([a-z-]+)"/g)].map((match) => match[1]);
      }
    }
  }
  return [];
}

try {
  let result = await settle(
    await call("bridge_orchestrate_codex", {
      coordinatorAgent: "smoke-coordinator",
      projectPath: repo,
      threadId: "live-smoke",
      useWorktree: true,
      maxRounds: 3,
      task:
        "Read README.md only. Do not edit files and do not run external actions. Before completing, you must ask the coordinator exactly this question using status needs_fable: 'Should an autonomous bridge cap handoffs to prevent loops?' After the answer, complete with a one-sentence summary that quotes the number in README.md.",
    }),
  );
  console.log(JSON.stringify({ phase: "start", status: result.status, runId: result.runId, question: result.question }));

  if (result.status === "waiting_for_fable") {
    result = await settle(
      await call("bridge_continue_codex", {
        runId: result.runId,
        fableAnswer: "Yes. Cap the rounds, persist each handoff, and stop as blocked at the cap.",
      }),
    );
  }
  const policies = sandboxPolicies(String(result.codexSessionId));
  console.log(
    JSON.stringify({
      phase: "final",
      status: result.status,
      summary: result.summary,
      worktreePath: result.worktreePath,
      observedChanges: result.observedChanges,
      sandboxPerTurn: policies,
    }),
  );
  const escalated = policies.filter((policy) => policy !== "workspace-write");
  if (result.status !== "completed") throw new Error(`Run ended ${result.status}`);
  if (policies.length < 2) throw new Error("Expected at least two turns in the Codex rollout");
  if (escalated.length) throw new Error(`Sandbox escalated on a resumed turn: ${escalated.join(", ")}`);
  console.log("✓ Live smoke passed: every turn ran in the workspace-write sandbox");
} catch (error) {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await client.close();
}
