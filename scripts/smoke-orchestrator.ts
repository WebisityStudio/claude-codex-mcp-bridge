import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = new URL("../", import.meta.url).pathname;
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/server.js"],
  cwd: root,
  env: {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    USER: process.env.USER ?? "",
  },
  stderr: "pipe",
});
const client = new Client({ name: "orchestrator-live-smoke", version: "1.0.0" });
await client.connect(transport);

function parse(result: Awaited<ReturnType<Client["callTool"]>>) {
  const item = result.content[0];
  if (!item || item.type !== "text") throw new Error("Expected text MCP result");
  return JSON.parse(item.text) as Record<string, unknown>;
}

try {
  let result = parse(
    await client.callTool(
      {
        name: "bridge_orchestrate_codex",
        arguments: {
          coordinatorAgent: "fable-live-smoke",
          projectPath: root.replace(/\/$/, ""),
          threadId: "autonomous-live-smoke",
          useWorktree: false,
          maxRounds: 3,
          task:
            "Read README.md only. Do not edit files and do not run external actions. Before completing, you must ask Claude Fable exactly this architecture question using status needs_fable: 'Should an autonomous bridge cap Fable/Codex handoffs to prevent loops?' After Fable answers, complete with a short summary and evidence that README.md was read.",
        },
      },
      undefined,
      { timeout: 10 * 60 * 1000 },
    ),
  );
  console.log(JSON.stringify({ phase: "start", status: result.status, runId: result.runId, question: result.question }));

  if (result.status === "waiting_for_fable") {
    result = parse(
      await client.callTool(
        {
          name: "bridge_continue_codex",
          arguments: {
            runId: result.runId,
            fableAnswer:
              "Yes. Use a strict round cap, persist each handoff, and stop as blocked when the cap is reached so the user can inspect the loop rather than silently spending more model time.",
          },
        },
        undefined,
        { timeout: 10 * 60 * 1000 },
      ),
    );
    console.log(
      JSON.stringify({
        phase: "continue",
        status: result.status,
        runId: result.runId,
        codexSessionId: result.codexSessionId,
        summary: result.summary,
        evidence: result.evidence,
      }),
    );
  }

  if (result.status !== "completed") process.exitCode = 1;
} finally {
  await client.close();
}
