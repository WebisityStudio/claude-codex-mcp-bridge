import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BridgeStore } from "../src/bridge-store.js";
import { wakeNotice } from "../src/wake-queue.js";
import { WakeDispatcher } from "../src/wake-dispatcher.js";

test("bindings opt in; broadcasts, self messages, quiet updates and retries cannot create ping storms", () => {
  const s = new BridgeStore(":memory:");
  try {
    s.register("old-client");
    s.send({ fromAgent: "a", toAgent: "old-client", body: "old workflow" });
    assert.equal(s.wakes.list().length, 0);
    s.wakes.bind("b", { app: "codex", sessionId: "task-b" });
    for (const input of [
      { fromAgent: "a", toAgent: "*", body: "broadcast" },
      { fromAgent: "b", toAgent: "b", body: "self" },
      { fromAgent: "a", toAgent: "b", body: "quiet", wake: false },
    ]) s.send(input);
    assert.equal(s.wakes.list().length, 0);
    const input = { fromAgent: "a", toAgent: "b", body: "work", idempotencyKey: "once" };
    const first = s.send(input);
    assert.deepEqual(s.send(input), first);
    assert.equal(s.wakes.list().length, 1);
    const visible = s.wakes.list()[0];
    assert.equal(visible.fromAgent, "a");
    assert.equal(visible.preview, "work");
    assert.ok(wakeNotice(visible).includes('"work"'));
    assert.equal(visible.acknowledgedAt, null);
    assert.throws(() => s.wakes.bind("b", { app: "codex", sessionId: "different-task" }), /already bound/);
    s.wakes.bind("b", null);
    assert.equal(s.wakes.list()[0].state, "cancelled");
    assert.equal(s.inbox("b").length, 4);
  } finally { s.close(); }
});

test("outbox persists, only one process can claim a ping, crashed deliveries are not replayed", () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-wake-queue-"));
  const path = join(dir, "bridge.sqlite");
  let a = new BridgeStore(path);
  a.wakes.bind("b", { app: "claude", sessionId: "session-b" });
  const message = a.send({ fromAgent: "a", toAgent: "b", body: "durable" });
  a.close();
  a = new BridgeStore(path);
  const b = new BridgeStore(path);
  try {
    const job = a.wakes.claim()!;
    assert.equal(job.messageId, message.id);
    assert.equal(b.wakes.claim(), null);
    assert.equal(b.wakes.claim(Date.now() + 31_000), null);
    assert.equal(b.wakes.list()[0].state, "unknown");
    assert.equal(b.inbox("b").length, 1);
    // A late positive receipt can settle the original attempt.
    a.wakes.finish(job, { state: "accepted", detail: "late receipt" });
    assert.equal(b.wakes.list()[0].state, "accepted");
    assert.equal(b.inbox("b").length, 1);
    b.wakes.recordRead("b", [message.id]);
    assert.equal(b.wakes.list()[0].state, "read");
    a.wakes.finish(job, { state: "held", detail: "late stale receipt" });
    assert.equal(b.wakes.list()[0].state, "read");
    assert.equal(b.inbox("b").length, 1);
  } finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("offline retry, held permission and recipient acknowledgement have distinct outcomes", async () => {
  const s = new BridgeStore(":memory:");
  s.wakes.bind("b", { app: "codex", sessionId: "b" });
  const message = s.send({ fromAgent: "a", toAgent: "b", body: "work" });
  let calls = 0;
  const d = new WakeDispatcher(s, async () => { calls++; return { state: "pending", detail: "offline" }; });
  try {
    await d.flush();
    await d.flush();
    assert.equal(calls, 1);
    const job = s.wakes.claim(Date.now() + 10_000)!;
    s.wakes.finish(job, { state: "held", detail: "needs approval" });
    assert.equal(s.wakes.claim(Date.now() + 60_000), null);
    assert.equal(s.inbox("b").length, 1);
    s.wakes.finish(job, { state: "accepted", detail: "approved by recipient" });
    assert.equal(s.wakes.list()[0].state, "accepted");
    s.ack("b", [message.id]);
    assert.equal(s.inbox("b").length, 0);
    assert.ok(s.wakes.forMessage(message.id)?.acknowledgedAt);
    const next = s.send({ fromAgent: "a", toAgent: "b", body: "already read" });
    s.ack("b", [next.id]);
    assert.equal(s.wakes.claim(), null);
    assert.equal(s.wakes.forMessage(next.id)?.state, "cancelled");
    const expired = s.send({ fromAgent: "a", toAgent: "b", body: "offline for an hour" });
    assert.equal(s.wakes.claim(Date.now() + 3_600_001), null);
    assert.equal(s.wakes.forMessage(expired.id)?.state, "expired");
    assert.equal(s.inbox("b")[0].body, "offline for an hour");
  } finally { await d.close(); s.close(); }
});
