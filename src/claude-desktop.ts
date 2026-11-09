import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { buildSafeEnvironment } from "./orchestrator.js";

/**
 * Hand a finished headless Claude Code chat to the Claude desktop app, using
 * the CLI's own `claude --desktop --resume <session-id>`.
 *
 * That command only runs in a terminal, so the bridge gives it one with the
 * system's `script` utility. The desktop app switches to the chat it opens,
 * which is why this happens only when the owner's policy allows it.
 */
export interface DesktopHandoff {
  shown: boolean;
  detail: string;
  /** What to run in a terminal, in the chat's folder, to open it by hand. */
  manualCommand: string;
}

const SCRIPT = "/usr/bin/script";

export interface HandoffInput {
  binary: string;
  cwd: string;
  sessionId: string;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  /** Test seam: the pseudo-terminal wrapper to use. */
  scriptPath?: string;
}

function quote(value: string): string {
  return /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

export function manualHandoffCommand(binary: string, sessionId: string): string {
  return `${quote(binary)} --desktop --resume ${sessionId}`;
}

export function showInClaudeDesktop(input: HandoffInput): Promise<DesktopHandoff> {
  const manualCommand = manualHandoffCommand(input.binary, input.sessionId);
  const platform = input.platform ?? process.platform;
  const script = input.scriptPath ?? SCRIPT;
  if (platform !== "darwin") {
    return Promise.resolve({ shown: false, detail: "Opening a chat in the Claude desktop app is only automated on macOS.", manualCommand });
  }
  if (!existsSync(script)) {
    return Promise.resolve({ shown: false, detail: `${script} is not available to give the command a terminal.`, manualCommand });
  }
  return new Promise((resolve) => {
    // BSD script: `script -q /dev/null command...` runs the command on a pseudo-terminal and records nothing.
    // Its own input must not be a socket (it then refuses to start), so it reads from /dev/null.
    const child = spawn(script, ["-q", "/dev/null", input.binary, "--desktop", "--resume", input.sessionId], {
      cwd: input.cwd,
      env: buildSafeEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    const settle = (result: DesktopHandoff) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const failed = (reason: string) =>
      settle({ shown: false, detail: `Claude Code did not open the chat in the desktop app: ${reason.slice(0, 300)}`, manualCommand });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      failed("it did not answer in time");
    }, input.timeoutMs ?? 30_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    child.once("error", (error) => failed(error.message));
    child.once("close", (code) => {
      const lines = output.replace(/\r/g, "").split("\n").map((line) => line.trim()).filter(Boolean);
      if (code === 0 && lines.some((line) => /Opening session/i.test(line))) {
        settle({ shown: true, detail: "Opened in the Claude desktop app.", manualCommand });
      } else failed(lines.at(-1) ?? `exit ${code ?? "by signal"} without a confirmation`);
    });
  });
}
