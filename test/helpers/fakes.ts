import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Stand-ins for the two command-line tools the bridge starts worker chats with.
// Each records how it was called, in the folder it was started in, and answers
// according to [[markers]] in the prompt (plain words would collide with the
// worker prompt itself: "change" contains "hang").

// A stand-in for the Claude Code CLI: it records how it was called and prints
// the single JSON result `claude -p --output-format json` prints.
export const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
appendFileSync(join(process.cwd(), "fake-claude-calls.jsonl"), JSON.stringify({ args }) + "\\n");
const value = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : null; };
if (args.includes("--desktop")) {
  if (process.env.FAKE_CLAUDE_REFUSE_DESKTOP || !process.stdout.isTTY) { process.stderr.write("--desktop opens the Claude Desktop app and can't run non-interactively\\n"); process.exit(1); }
  process.stdout.write("Opening session " + value("--resume") + " in Claude Desktop\\n");
  process.exit(0);
}
const sessionId = value("--session-id") ?? value("--resume");
let prompt = "";
process.stdin.on("data", (chunk) => (prompt += chunk));
process.stdin.on("end", () => {
  const base = { type: "result", subtype: "success", is_error: false, session_id: sessionId, num_turns: 1, total_cost_usd: 0.001, permission_denials: [] };
  if (prompt.includes("[[signed-out]]")) { console.log(JSON.stringify({ ...base, is_error: true, result: "Failed to authenticate: OAuth session expired and could not be refreshed" })); process.exit(1); }
  if (prompt.includes("[[garbage]]")) { process.stderr.write("claude: something broke"); process.exit(2); }
  if (prompt.includes("[[plain]]")) { console.log(JSON.stringify({ ...base, result: "Here is what I found: all good." })); return; }
  if (prompt.includes("[[denied]]")) base.permission_denials = [{ tool_name: "Bash" }, { tool_name: "Bash" }, { tool_name: "Edit" }];
  const asks = prompt.includes("[[ask]]") && !prompt.includes("answered your question");
  const envelope = { status: asks ? "needs_fable" : "completed", summary: "handled: " + prompt.slice(0, 24), evidence: [], question: asks ? "Which option?" : "", filesChanged: [], tests: [], suggestedChips: [] };
  console.log(JSON.stringify({ ...base, result: JSON.stringify(envelope), structured_output: envelope }));
});
`;

export function fakeClaude(): { dir: string; binary: string; calls: (cwd?: string) => string[][] } {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  const binary = join(dir, "claude");
  writeFileSync(binary, FAKE_CLAUDE, { mode: 0o755 });
  // ESM package scope must not apply to the fake binary.
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "commonjs" }));
  chmodSync(binary, 0o755);
  return {
    dir,
    binary,
    calls: (cwd = dir) =>
      readFileSync(join(cwd, "fake-claude-calls.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { args: string[] }).args),
  };
}

// A stand-in for `codex app-server`: it speaks the same JSON-lines protocol,
// records what it was asked, and answers according to the prompt.
export const FAKE_APP_SERVER = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { join } = require("node:path");
const calls = join(process.cwd(), "fake-codex-calls.jsonl");
const record = (entry) => appendFileSync(calls, JSON.stringify(entry) + "\\n");
record({ argv: process.argv.slice(2) });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    record({ method: message.method, params: message.params ?? null });
    if (message.method === "initialize") send({ id: message.id, result: { userAgent: "fake" } });
    else if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "fake-thread-1" }, model: message.params.model ?? "default-model" } });
    else if (message.method === "thread/resume") send({ id: message.id, result: { thread: { id: message.params.threadId } } });
    else if (message.method === "thread/name/set") send({ id: message.id, result: {} });
    else if (message.method === "turn/start") {
      const { threadId } = message.params;
      const prompt = message.params.input[0].text;
      if (prompt.includes("[[crash]]")) { process.stderr.write("fake server lost its mind"); process.exit(7); }
      const envelope = { status: "completed", summary: "handled: " + prompt.slice(0, 24), evidence: [], question: "", filesChanged: [], tests: [], suggestedChips: [] };
      // Everything in one write: the reply and the turn's events arrive in the same read.
      const out = [{ id: message.id, result: { turn: { id: "turn-1", status: "inProgress", items: [] } } }];
      if (!prompt.includes("[[hang]]")) {
        out.push(
          { method: "turn/started", params: { threadId, turn: { id: "turn-1" } } },
          { method: "item/agentMessage/delta", params: { threadId, turnId: "turn-1", delta: "handl" } },
          { method: "item/completed", params: { threadId: "sub-agent-thread", turnId: "turn-9", item: { type: "agentMessage", id: "x", text: "SUBAGENT TEXT" } } },
          { method: "item/completed", params: { threadId, turnId: "turn-1", item: { type: "agentMessage", id: "m1", text: "Working on it." } } },
          { method: "item/completed", params: { threadId, turnId: "turn-1", item: { type: "agentMessage", id: "m2", text: JSON.stringify(envelope) } } },
        );
        if (prompt.includes("[[fail]]")) {
          out.push({ method: "error", params: { threadId, turnId: "turn-1", willRetry: false, error: { message: "model refused" } } },
                   { method: "turn/completed", params: { threadId, turn: { id: "turn-1", status: "failed", items: [], error: { message: "model refused" } } } });
        } else out.push({ method: "turn/completed", params: { threadId, turn: { id: "turn-1", status: "completed", items: [] } } });
      }
      process.stdout.write(out.map((entry) => JSON.stringify(entry)).join("\\n") + "\\n");
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`;

export function fakeCodex(): { dir: string; binary: string; calls: (cwd?: string) => Array<Record<string, any>> } {
  const dir = mkdtempSync(join(tmpdir(), "fake-app-server-"));
  const binary = join(dir, "codex");
  writeFileSync(binary, FAKE_APP_SERVER, { mode: 0o755 });
  // ESM package scope must not apply to the fake binary.
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "commonjs" }));
  chmodSync(binary, 0o755);
  return {
    dir,
    binary,
    calls: (cwd = dir) => readFileSync(join(cwd, "fake-codex-calls.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)),
  };
}
