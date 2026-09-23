import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

function normalise(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/**
 * Process start time as `ps` reports it (UTC, C locale). Stored next to a PID
 * so a later check can tell the original process from a reused PID.
 */
export async function processStartTime(pid: number | undefined | null): Promise<string | null> {
  if (process.platform === "win32" || !pid || !Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    const { stdout } = await execute("ps", ["-p", String(pid), "-o", "lstart="], {
      timeout: 2000,
      env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
    });
    return normalise(stdout) || null;
  } catch {
    return null;
  }
}

/** True when `pid` is alive, owned by this user and (if known) started when expected. */
export async function isProcessAlive(
  pid: number | null | undefined,
  expectedStart?: string | null,
): Promise<boolean> {
  if (!pid || !Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
  } catch {
    // ESRCH: gone. EPERM: another user's process, so not one of ours.
    return false;
  }
  if (!expectedStart) return true;
  const actual = await processStartTime(pid);
  return actual === null || actual === normalise(expectedStart);
}

/**
 * Stop a detached child and everything it started. Children are spawned as
 * process-group leaders on Unix, so the whole group receives the signal.
 */
export function terminateProcessTree(pid: number, graceMs = 5000): void {
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(process.platform === "win32" ? pid : -pid, name);
    } catch {
      try {
        process.kill(pid, name);
      } catch {
        // Already gone.
      }
    }
  };
  signal("SIGTERM");
  setTimeout(() => signal("SIGKILL"), graceMs).unref();
}
