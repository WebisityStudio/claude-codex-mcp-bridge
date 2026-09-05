import { dirname } from "node:path";
import { lstat } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";

export async function privatePath(path: string, kind: "socket" | "file" | "directory"): Promise<void> {
  const stat = await lstat(path);
  const matches = kind === "socket" ? stat.isSocket() : kind === "file" ? stat.isFile() : stat.isDirectory();
  if (!matches || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error("Local IPC path has unexpected ownership, type or permissions");
  }
}

export class IpcError extends Error {
  constructor(message: string, readonly sent = false) { super(message); }
}

type Packet = Record<string, any>;
export class CodexIpc {
  private socket: Socket | null = null;
  private buffer = Buffer.alloc(0);
  private clientId = "initializing-client";
  private pending = new Map<string, { resolve: (p: Packet) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  async connect(path: string): Promise<void> {
    await privatePath(dirname(path), "directory");
    await privatePath(path, "socket");
    await new Promise<void>((resolve, reject) => {
      const socket = this.socket = createConnection(path);
      const timer = setTimeout(() => { socket.destroy(); reject(new IpcError("Codex connection timed out")); }, 3000);
      socket.once("connect", () => { clearTimeout(timer); resolve(); });
      socket.on("error", () => { clearTimeout(timer); reject(new IpcError("Codex connection unavailable")); this.fail(); });
      socket.on("close", () => this.fail());
      socket.on("data", chunk => {
        try { this.read(chunk); } catch { socket.destroy(); this.fail(); }
      });
    });
    const reply = await this.request("initialize", { clientType: "claude-codex-bridge" });
    if (reply.resultType !== "success" || typeof reply.result?.clientId !== "string") {
      throw new IpcError("Codex IPC initialization rejected");
    }
    this.clientId = reply.result.clientId;
  }

  private fail(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer); p.reject(new IpcError("Codex IPC response unavailable", true));
    }
    this.pending.clear();
  }

  private write(packet: Packet): void {
    const body = Buffer.from(JSON.stringify(packet));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    this.socket!.write(Buffer.concat([header, body]));
  }

  private read(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > 8 * 1024 * 1024) throw new Error("IPC frame too large");
      if (this.buffer.length < length + 4) return;
      const p = JSON.parse(this.buffer.subarray(4, length + 4).toString());
      this.buffer = this.buffer.subarray(length + 4);
      if (p.type === "client-discovery-request") {
        this.write({ type: "client-discovery-response", requestId: p.requestId, response: { canHandle: false } });
      } else if (p.type === "response") {
        const waiting = this.pending.get(p.requestId);
        if (!waiting) continue;
        this.pending.delete(p.requestId);
        clearTimeout(waiting.timer); waiting.resolve(p);
      }
      // Never publish unsolicited app broadcasts or conversation content.
    }
  }

  request(method: string, params: Packet, version = 0, targetClientId?: string): Promise<Packet> {
    if (!this.socket || this.socket.destroyed) return Promise.reject(new IpcError("Codex disconnected"));
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new IpcError("Codex IPC response timed out", true));
      }, 10_000);
      this.pending.set(requestId, { resolve, reject, timer });
      this.write({ type: "request", requestId, sourceClientId: this.clientId, version, method, params,
        ...(targetClientId ? { targetClientId } : {}) });
    });
  }

  close(): void { this.socket?.destroy(); this.fail(); }
}
