import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { ClaudeWake, claudeSessions } from "../src/claude-wake.js";
import type { WakeJob } from "../src/wake-queue.js";

test("Claude authenticates as peer, preserves exact session and reports real held/refused receipts", { skip: process.platform !== "darwin" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wake-claude-registry-"));
  const directory = "/tmp/cc-socks-" + process.getuid!();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, process.pid + "-" + randomBytes(4).toString("hex") + ".sock");
  const procStart = execFileSync("/bin/ps", ["-p", String(process.pid), "-o", "lstart="],
    { encoding: "utf8", env: { ...process.env, TZ: "UTC", LC_ALL: "C" } }).trim();
  const token = randomBytes(16).toString("hex");
  const keyPath = join(root, process.pid + "." + createHash("sha256").update(resolve(path)).digest("hex") + ".key");
  const metadata = { pid: process.pid, sessionId: "internal-test-session", bridgeSessionId: "desktop-test-session",
    name: "fixture", cwd: root, procStart, messagingSocketPath: path, version: "2.1.260", peerProtocol: 1 };
  writeFileSync(join(root, process.pid + ".json"), JSON.stringify(metadata), { mode: 0o644 });
  writeFileSync(keyPath, JSON.stringify({ peerToken: token, procStart }), { mode: 0o600 });
  let status = "held";
  let transmissions = 0;
  const server = createServer(socket => {
    let buffer = "", authenticated = false;
    socket.on("error", () => {});
    socket.on("data", data => {
      buffer += data.toString();
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        const packet = JSON.parse(line);
        if (packet.type === "auth") { authenticated = packet.token === token; continue; }
        assert.equal(authenticated, true);
        transmissions++;
        assert.equal(packet.type, "user");
        assert.equal(packet.session_id, "internal-test-session");
        assert.equal(packet.priority, "next");
        assert.equal("from_mode" in packet, false);
        assert.equal("selfSent" in packet, false);
        assert.ok(packet.message.content.includes("/test/bridge.sqlite"));
        const reply = createConnection(packet.from.slice(4));
        reply.on("error", () => {});
        reply.once("connect", () => reply.end(JSON.stringify({
          type: "control", action: "peer_message_status", status,
          orig_msg_id: packet.msg_id, from: "uds:" + path,
        }) + "\n"));
      }
    });
  });
  await new Promise<void>(ok => server.listen(path, ok));
  chmodSync(path, 0o600);
  const adapter = new ClaudeWake();
  const job: WakeJob = { id: 1, messageId: 1, mailboxPath: "/test/bridge.sqlite", agent: "b",
    target: { app: "claude", sessionId: "desktop-test-session" }, state: "sending",
    attemptId: "attempt-held", attempts: 1, retryAt: 0, createdAt: Date.now(), detail: "" };
  try {
    assert.equal((await claudeSessions(root)).length, 1);
    assert.equal((await adapter.wake(job, root)).state, "held");
    status = "refused";
    assert.equal((await adapter.wake({ ...job, attemptId: "attempt-refused" }, root)).state, "refused");
    assert.equal(transmissions, 2);
    assert.equal((await adapter.wake({ ...job, target: { app: "claude", sessionId: "wrong-session" } }, root)).state, "pending");
    // A readable-by-others key must never be used, even though metadata may be public.
    chmodSync(keyPath, 0o644);
    assert.equal((await adapter.wake({ ...job, attemptId: "unsafe-key" }, root)).state, "pending");
    assert.equal(transmissions, 2);
    chmodSync(keyPath, 0o600);
    writeFileSync(join(root, process.pid + ".json"), JSON.stringify({ ...metadata, procStart: "stale process" }));
    assert.deepEqual(await claudeSessions(root), []);
  } finally {
    await adapter.close();
    await new Promise<void>(ok => server.close(() => ok()));
    rmSync(root, { recursive: true, force: true });
  }
});
