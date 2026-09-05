import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { privatePath } from "./local-ipc.js";
import { wakeNotice, type WakeJob, type WakeResult } from "./wake-queue.js";

const execute = promisify(execFile);
export interface ClaudeSession {
  pid: number; sessionId: string; bridgeSessionId?: string; cwd: string; name: string;
  messagingSocketPath: string; procStart: string; version: string; peerProtocol: number;
}
const sessionRoot = () => join(homedir(), ".claude", "sessions");

async function boundedJson(path: string, max = 16_384, publicMetadata = false): Promise<Record<string, any>> {
  if (publicMetadata) {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) throw new Error("Unsafe session registry entry");
  } else await privatePath(path, "file");
  if ((await lstat(path)).size > max) throw new Error("IPC metadata too large");
  return JSON.parse(await readFile(path, "utf8"));
}

async function liveOwner(s: ClaudeSession): Promise<boolean> {
  if (process.platform !== "darwin" || !Number.isSafeInteger(s.pid) || s.pid < 1) return false;
  try {
    const { stdout } = await execute("/bin/ps", ["-p", String(s.pid), "-o", "uid=", "-o", "lstart="], { timeout: 2000, env: { ...process.env, TZ: "UTC", LC_ALL: "C" } });
    const match = stdout.trim().match(/^(\d+)\s+(.+)$/);
    return !!match && Number(match[1]) === process.getuid?.() &&
      match[2].replace(/\s+/g, " ") === s.procStart.replace(/\s+/g, " ");
  } catch { return false; }
}

export async function claudeSessions(root = sessionRoot()): Promise<ClaudeSession[]> {
  if (process.platform !== "darwin") return [];
  let files: string[];
  try { files = await readdir(root); } catch { return []; }
  const sessions: ClaudeSession[] = [];
  for (const file of files.filter(name => /^\d+\.json$/.test(name))) {
    try {
      const raw = await boundedJson(join(root, file), 16_384, true);
      if (String(raw.pid) + ".json" !== file || typeof raw.sessionId !== "string" ||
          typeof raw.procStart !== "string" || typeof raw.messagingSocketPath !== "string") continue;
      const allowedDirs = ["/tmp/cc-socks", "/private/tmp/cc-socks",
        "/tmp/cc-socks-" + process.getuid?.(), "/private/tmp/cc-socks-" + process.getuid?.()];
      if (!allowedDirs.includes(dirname(raw.messagingSocketPath)) ||
          !new RegExp("^" + raw.pid + "(?:-[0-9a-f]{8})?\\.sock$").test(raw.messagingSocketPath.split("/").pop()!)) continue;
      const session: ClaudeSession = {
        pid: raw.pid, sessionId: raw.sessionId, bridgeSessionId: raw.bridgeSessionId,
        cwd: raw.cwd, name: raw.name, messagingSocketPath: raw.messagingSocketPath,
        procStart: raw.procStart, version: raw.version, peerProtocol: raw.peerProtocol,
      };
      await privatePath(session.messagingSocketPath, "socket");
      if (await liveOwner(session)) sessions.push(session);
    } catch { /* A stale or unreadable registry entry is not an address. */ }
  }
  return sessions;
}

export class ClaudeWake {
  private server: Server | null = null;
  private sockets = new Set<Socket>();
  private path: string | null = null;
  private pending = new Map<string, { job: WakeJob; settle: (r: WakeResult) => void; timer: NodeJS.Timeout }>();

  constructor(private onLateReceipt: (job: WakeJob, result: WakeResult) => void = () => {}) {}

  private async listen(directory: string): Promise<string> {
    if (this.path) return this.path;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await privatePath(directory, "directory");
    const path = join(directory, process.pid + "-" + randomBytes(4).toString("hex") + ".sock");
    const server = createServer(socket => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      socket.on("error", () => {});
      socket.setTimeout(2000, () => socket.destroy());
      let buffer = "";
      socket.on("data", data => {
        buffer += data.toString();
        if (buffer.length > 16_384) { socket.destroy(); return; }
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          try {
            const receipt = JSON.parse(line);
            if (receipt.type !== "control" || receipt.action !== "peer_message_status") continue;
            const p = this.pending.get(receipt.orig_msg_id);
            if (!p) continue;
            let result: WakeResult;
            if (receipt.status === "delivered") result = { state: "accepted", detail: "Claude confirmed peer delivery" };
            else if (receipt.status === "held") result = { state: "held", detail: "Claude retained this peer ping but has not admitted it to the model. Its permission mode requires approval; the desktop app may not display a card. Do not resend." };
            else if (["denied", "refused", "dropped", "expired"].includes(receipt.status)) result = { state: "refused", detail: "Claude " + receipt.status + " this peer message" };
            else continue;
            clearTimeout(p.timer);
            p.settle(result);
            this.onLateReceipt(p.job, result);
            if (receipt.status !== "held") this.pending.delete(receipt.orig_msg_id);
          } catch { /* No message bodies or credentials enter diagnostics. */ }
        }
      });
    });
    await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(path, ok); });
    await chmod(path, 0o600);
    this.server = server; this.path = path;
    return path;
  }

  async wake(job: WakeJob, root = sessionRoot()): Promise<WakeResult> {
    if (process.platform !== "darwin") return { state: "refused", detail: "Claude desktop wake adapter currently supports macOS only" };
    let written = false;
    try {
      const matches = (await claudeSessions(root)).filter(s =>
        s.sessionId === job.target.sessionId || s.bridgeSessionId === job.target.sessionId);
      if (matches.length !== 1) return { state: "pending", detail: "Claude session has no unique live local inbox" };
      const session = matches[0];
      if (session.peerProtocol !== 1) return { state: "refused", detail: "Unsupported Claude peer protocol" };
      const hash = createHash("sha256").update(resolve(session.messagingSocketPath)).digest("hex");
      // Use only the peer capability published for this inbox. Never read a child token.
      const key = await boundedJson(join(root, session.pid + "." + hash + ".key"), 4096);
      if (typeof key.peerToken !== "string" || !/^[0-9a-f]{32}$/.test(key.peerToken) ||
          key.procStart !== session.procStart) return { state: "refused", detail: "Claude inbox authentication metadata does not match its process" };
      const callback = await this.listen(dirname(session.messagingSocketPath));
      if (!await liveOwner(session)) return { state: "pending", detail: "Claude process stopped before delivery" };
      // Bound retained receipt routes even when peers never send a positive receipt.
      for (const [oldId, p] of this.pending) {
        if (Date.now() - p.job.createdAt > 3_600_000 || this.pending.size >= 100) {
          clearTimeout(p.timer); this.pending.delete(oldId);
        }
      }
      const id = job.attemptId!;
      const result = new Promise<WakeResult>(settle => {
        const timer = setTimeout(() => {
          settle({ state: "unknown", detail: "Ping submitted; awaiting Claude receipt. No automatic replay." });
        }, 1800);
        this.pending.set(id, { job, settle, timer });
      });
      await new Promise<void>((ok, fail) => {
        const socket = createConnection(session.messagingSocketPath);
        socket.setTimeout(2000, () => { socket.destroy(); fail(new Error("IPC timeout")); });
        socket.once("error", fail);
        socket.once("connect", () => {
          written = true;
          socket.end(JSON.stringify({ type: "auth", token: key.peerToken }) + "\n" +
            JSON.stringify({ type: "user", msgV: 1, msg_id: id, session_id: session.sessionId,
              from: "uds:" + callback, priority: "next",
              message: { role: "user", content: wakeNotice(job) } }) + "\n", ok);
        });
      });
      return await result;
    } catch {
      if (!written && job.attemptId) {
        const p = this.pending.get(job.attemptId);
        if (p) { clearTimeout(p.timer); this.pending.delete(job.attemptId); }
      }
      return written
        ? { state: "unknown", detail: "Claude delivery outcome unavailable; no automatic replay" }
        : { state: "pending", detail: "Claude local inbox unavailable or failed ownership checks" };
    }
  }

  async close(): Promise<void> {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer); p.settle({ state: "unknown", detail: "Bridge stopped before receiving Claude receipt" });
    }
    this.pending.clear();
    for (const socket of this.sockets) socket.destroy();
    if (this.server) await new Promise<void>(ok => this.server!.close(() => ok()));
    if (this.path) await unlink(this.path).catch(() => {});
    this.server = null; this.path = null;
  }
}
