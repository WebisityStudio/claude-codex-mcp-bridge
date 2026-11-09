#!/usr/bin/env node
/**
 * One Codex worker turn through `codex app-server`, the documented protocol
 * the Codex apps themselves use. The bridge starts this file as a detached
 * process, exactly as it starts `codex exec`: the prompt arrives on stdin,
 * events leave on stdout as JSON lines, and the final answer is written to a
 * file. A chat started this way is an ordinary interactive chat, so the Codex
 * app lists it, which it never does for `codex exec` sessions.
 *
 * The folder, sandbox and approval policy are stated on the command line, on
 * the thread and again on the turn, so no default in the user's own Codex
 * configuration can widen them.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { VERSION } from "./version.js";

export interface AppTurnOptions {
  codex: string;
  cwd: string;
  sandbox: "read-only" | "workspace-write";
  outputPath: string;
  schemaPath: string;
  /** Resume this thread, or start a new one when null. */
  sessionId: string | null;
  model: string | null;
  effort: string | null;
  title: string | null;
  /** Leading `-c` pairs for the app-server command line, pinned safety values last. */
  config: string[];
}

type Json = Record<string, any>;

export function appServerArgs(options: Pick<AppTurnOptions, "config">): string[] {
  return ["app-server", ...options.config];
}

/** The per-turn sandbox, stated in full so the turn does not depend on thread or config defaults. */
export function turnSandboxPolicy(sandbox: AppTurnOptions["sandbox"]): Json {
  return sandbox === "read-only"
    ? { type: "readOnly", networkAccess: false }
    : { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeSlashTmp: false, excludeTmpdirEnvVar: false };
}

export function threadParams(options: AppTurnOptions): Json {
  return {
    ...(options.sessionId ? { threadId: options.sessionId } : {}),
    cwd: options.cwd,
    sandbox: options.sandbox,
    approvalPolicy: "never",
    ...(options.model ? { model: options.model } : {}),
  };
}

export function turnParams(options: AppTurnOptions, threadId: string, prompt: string, outputSchema: unknown): Json {
  return {
    threadId,
    input: [{ type: "text", text: prompt, text_elements: [] }],
    approvalPolicy: "never",
    sandboxPolicy: turnSandboxPolicy(options.sandbox),
    outputSchema,
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
  };
}

/** Streaming fragments would dominate the event log; the completed items carry the same text. */
function worthLogging(method: string): boolean {
  return !/[dD]elta$/.test(method) && method !== "item/commandExecution/terminalInteraction";
}

export interface AppTurnIo {
  spawnServer(command: string, args: string[], cwd: string): ChildProcess;
  emit(line: string): void;
}

/**
 * Drive one turn to completion. Resolves with the final answer text; rejects
 * with a one-line reason when the turn fails or the server goes away.
 */
export async function runAppTurn(options: AppTurnOptions, prompt: string, io: AppTurnIo): Promise<string> {
  const outputSchema = JSON.parse(readFileSync(options.schemaPath, "utf8")) as unknown;
  const server = io.spawnServer(options.codex, appServerArgs(options), options.cwd);
  const pending = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void }>();
  let nextId = 1;
  let buffer = "";
  let stderr = "";
  let threadId: string | null = null;
  let turnRequested = false;
  let answer: string | null = null;
  let lastError: string | null = null;
  let finish: ((result: { ok: true } | { ok: false; reason: string }) => void) | null = null;
  const finished = new Promise<{ ok: true } | { ok: false; reason: string }>((resolve) => (finish = resolve));

  const send = (message: Json) => server.stdin?.write(`${JSON.stringify(message)}\n`);
  const request = (method: string, params: Json): Promise<Json> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });

  const onMessage = (message: Json) => {
    if (message.id !== undefined && message.method === undefined) {
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      if (message.error) waiting.reject(new Error(String(message.error.message ?? JSON.stringify(message.error))));
      else waiting.resolve((message.result ?? {}) as Json);
      return;
    }
    if (message.id !== undefined) {
      // Approvals and other questions have nobody to answer them in a worker turn.
      send({ id: message.id, error: { code: -32601, message: "The bridge runs worker turns without interactive approvals." } });
      return;
    }
    const method = String(message.method ?? "");
    const params = (message.params ?? {}) as Json;
    if (worthLogging(method)) io.emit(JSON.stringify({ type: method, ...params }));
    // This process runs exactly one turn on one thread; other threads are sub-agents of it.
    if (!turnRequested || params.threadId !== threadId) return;
    if (method === "item/completed" && params.item?.type === "agentMessage" && typeof params.item.text === "string") {
      answer = params.item.text;
    } else if (method === "error" && typeof params.error?.message === "string") {
      lastError = params.error.message;
    } else if (method === "turn/completed") {
      const status = String(params.turn?.status ?? "unknown");
      if (status === "completed") finish?.({ ok: true });
      else finish?.({ ok: false, reason: `Codex turn ${status}: ${params.turn?.error?.message ?? lastError ?? "no detail"}` });
    }
  };

  server.stdout?.setEncoding("utf8");
  server.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        onMessage(JSON.parse(line) as Json);
      } catch {
        // Not a protocol line; ignore it.
      }
    }
  });
  server.stderr?.setEncoding("utf8");
  server.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  server.stdin?.on("error", () => {});
  server.once("error", (error) => finish?.({ ok: false, reason: `Could not start ${options.codex}: ${error.message}` }));
  server.once("exit", (code) => {
    const reason = `Codex app-server exited${code === null ? "" : ` with ${code}`} before the turn finished${stderr.trim() ? `: ${stderr.trim().slice(-600)}` : ""}`;
    for (const waiting of pending.values()) waiting.reject(new Error(reason));
    pending.clear();
    finish?.({ ok: false, reason });
  });

  try {
    await request("initialize", { clientInfo: { name: "claude-codex-bridge", title: "Claude Codex Bridge", version: VERSION } });
    send({ method: "initialized" });
    const opened = await request(options.sessionId ? "thread/resume" : "thread/start", threadParams(options));
    const id = String(opened.thread?.id ?? options.sessionId ?? "");
    if (!id) throw new Error("Codex did not return a thread");
    threadId = id;
    // The same first line `codex exec --json` prints, so the bridge learns the session the same way.
    io.emit(JSON.stringify({ type: "thread.started", thread_id: id }));
    if (!options.sessionId && options.title) {
      await request("thread/name/set", { threadId: id, name: options.title }).catch(() => {});
    }
    // Set before the request leaves: its first events can arrive in the same read as its reply.
    turnRequested = true;
    await request("turn/start", turnParams(options, id, prompt, outputSchema));
    const result = await finished;
    if (!result.ok) throw new Error(result.reason);
    if (answer === null) throw new Error("Codex finished the turn without a final message");
    return answer;
  } finally {
    server.stdin?.end();
    const stop = setTimeout(() => server.kill("SIGTERM"), 1500);
    stop.unref();
  }
}

async function readStdin(): Promise<string> {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function main(): Promise<void> {
  let server: ChildProcess | null = null;
  const stop = () => {
    server?.kill("SIGTERM");
    process.exit(143);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    const options = JSON.parse(process.argv[2] ?? "") as AppTurnOptions;
    const prompt = await readStdin();
    const answer = await runAppTurn(options, prompt, {
      spawnServer: (command, args, cwd) => (server = spawn(command, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] })),
      emit: (line) => process.stdout.write(`${line}\n`),
    });
    writeFileSync(options.outputPath, answer, { mode: 0o600 });
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

function isEntryPoint(): boolean {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) await main();
