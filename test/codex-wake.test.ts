import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import test from "node:test";
import { wakeCodex } from "../src/codex-wake.js";
import type { WakeJob } from "../src/wake-queue.js";

const job: WakeJob = { id: 1, messageId: 7, mailboxPath: "/test/bridge.sqlite", agent: "b",
  target: { app: "codex", sessionId: "exact-task" }, state: "sending", attemptId: "attempt-1",
  attempts: 1, retryAt: 0, createdAt: 0, detail: "" };

test("real framed IPC respects discovery, exact task, untrusted content and an accepted turn receipt", { skip: process.platform === "win32" }, async () => {
  for (const mode of ["success", "busy", "old", "ambiguous", "disconnect"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "wake-codex-"));
    const path = join(dir, "ipc.sock");
    const requests: any[] = [];
    const server = createServer(socket => {
      let buffer = Buffer.alloc(0);
      socket.on("error", () => {});
      socket.on("data", chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4) {
          const size = buffer.readUInt32LE(0);
          if (buffer.length < size + 4) return;
          const r = JSON.parse(buffer.subarray(4, size + 4).toString());
          buffer = buffer.subarray(size + 4); requests.push(r);
          let result: any = { clientId: "test-client" }, error: string | undefined;
          if (r.method === "thread-owner-discovery") result = { supportsUntrustedAppInput: mode !== "old" };
          if (r.method === "thread-follower-start-turn") {
            if (mode === "disconnect") { socket.destroy(); return; }
            result = mode === "ambiguous" ? {} : { result: { turn: { id: "new-turn" } } };
            if (mode === "busy") error = "App context must wait until the current turn finishes";
          }
          const body = Buffer.from(JSON.stringify({ type: "response", requestId: r.requestId,
            resultType: error ? "error" : "success", result, error, handledByClientId: "owner" }));
          const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
          // Exercise partial frames.
          socket.write(header.subarray(0, 2)); socket.write(Buffer.concat([header.subarray(2), body]));
        }
      });
    });
    await new Promise<void>(ok => server.listen(path, ok));
    chmodSync(path, 0o600);
    try {
      const result = await wakeCodex(job, path);
      assert.equal(result.state, { success: "accepted", busy: "pending", old: "refused", ambiguous: "unknown", disconnect: "unknown" }[mode]);
      const start = requests.find(r => r.method === "thread-follower-start-turn");
      if (mode === "old") { assert.equal(start, undefined); continue; }
      assert.equal(start.version, 2);
      assert.equal(start.targetClientId, "owner");
      assert.equal(start.params.conversationId, "exact-task");
      assert.equal(start.params.turnStart.request.threadId, "exact-task");
      assert.deepEqual(start.params.turnStart.request.input, []);
      const items = start.params.turnStart.context.responseItems;
      assert.equal(items[0].name, "untrusted_input");
      assert.equal(items[1].type, "function_call_output");
      assert.match(items[1].output[0].text, /Bridge message #7/);
      assert.ok(items[1].output[0].text.includes("/test/bridge.sqlite"));
      assert.equal(JSON.stringify(start).includes("developer"), false);
      assert.equal("permissions" in start.params.turnStart.request, false);
    } finally {
      await new Promise<void>(ok => server.close(() => ok()));
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
