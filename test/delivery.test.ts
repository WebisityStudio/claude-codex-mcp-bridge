import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BridgeStore } from "../src/bridge-store.js";
import { CHANNEL_METHOD, channelSession, type ChannelNotification } from "../src/claude-channel.js";
import { dailyBackup, Housekeeper, pruneRunFiles } from "../src/housekeeping.js";
import { sweepDeliveryFailures } from "../src/notices.js";
import { WakeDispatcher } from "../src/wake-dispatcher.js";
import { BUSY_WAKE_WINDOW_MS, OFFLINE_WAKE_WINDOW_MS } from "../src/wake-queue.js";

const HOUR = 3_600_000;

test("a busy Codex recipient keeps its ping for a day; an unreachable one for an hour", () => {
  const store = new BridgeStore(":memory:");
  store.wakes.bind("busy", { app: "codex", sessionId: "busy-task" });
  store.wakes.bind("offline", { app: "codex", sessionId: "gone-task" });
  const busy = store.send({ fromAgent: "a", toAgent: "busy", body: "long turn" });
  const offline = store.send({ fromAgent: "a", toAgent: "offline", body: "closed app" });
  const now = Date.now();
  for (const reason of ["busy", "offline"] as const) {
    const job = store.wakes.claim(now);
    assert.ok(job);
    store.wakes.finish(job, { state: "pending", detail: reason, reason: job.agent === "busy" ? "busy" : "offline" });
  }
  const later = now + OFFLINE_WAKE_WINDOW_MS + HOUR;
  const retried = store.wakes.claim(later);
  assert.equal(retried?.agent, "busy", "the busy ping is retried, not expired");
  assert.equal(store.wakes.forMessage(offline.id)?.state, "expired");
  store.wakes.finish(retried!, { state: "pending", detail: "still working", reason: "busy" });
  assert.equal(store.wakes.claim(now + BUSY_WAKE_WINDOW_MS + HOUR), null);
  const expired = store.wakes.forMessage(busy.id);
  assert.equal(expired?.state, "expired");
  assert.match(expired?.detail ?? "", /stayed busy/);
  store.close();
});

test("senders are told once when a ping fails, and never about bridge notices", () => {
  const store = new BridgeStore(":memory:");
  store.register("codex-sender");
  store.register("claude-recipient");
  store.wakes.bind("claude-recipient", { app: "claude", sessionId: "bypass-session" });
  store.wakes.bind("codex-sender", { app: "codex", sessionId: "sender-task" });
  const message = store.send({ fromAgent: "codex-sender", toAgent: "claude-recipient", body: "please review", threadId: "review-1" });
  const job = store.wakes.claim();
  assert.equal(job?.messageId, message.id);
  store.wakes.finish(job!, { state: "refused", detail: "Claude expired this peer message" });

  const now = Date.now();
  assert.equal(sweepDeliveryFailures(store, now), 1);
  const notices = store.inbox("codex-sender");
  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.fromAgent, "bridge");
  assert.equal(notices[0]?.threadId, "review-1");
  assert.match(notices[0]?.body ?? "", new RegExp(`#${message.id}`));
  assert.match(notices[0]?.body ?? "", /crossSessionInbound/);
  assert.match(notices[0]?.body ?? "", /still unread/);
  assert.equal(sweepDeliveryFailures(store, now), 0, "each failure is reported once");

  // The notice pings the sender. If that ping fails too, no further notice follows.
  const noticePing = store.wakes.claim();
  assert.equal(noticePing?.agent, "codex-sender");
  assert.equal(noticePing?.fromAgent, "bridge");
  store.wakes.finish(noticePing!, { state: "refused", detail: "Codex owner does not support peer content; update the app" });
  sweepDeliveryFailures(store, now);
  assert.equal(store.outbox("bridge", { includeAcknowledged: true }).entries.length, 1);

  // Another failed ping to the same recipient in the same half hour is coalesced.
  store.send({ fromAgent: "codex-sender", toAgent: "claude-recipient", body: "again" });
  const second = store.wakes.claim();
  assert.equal(second?.agent, "claude-recipient");
  store.wakes.finish(second!, { state: "refused", detail: "Claude expired this peer message" });
  assert.equal(sweepDeliveryFailures(store, now), 1);
  assert.equal(store.inbox("codex-sender").length, 1);
  store.close();
});

test("unregistered senders get no notice", () => {
  const store = new BridgeStore(":memory:");
  store.wakes.bind("recipient", { app: "codex", sessionId: "task" });
  store.send({ fromAgent: "anonymous", toAgent: "recipient", body: "hi" });
  const job = store.wakes.claim()!;
  store.wakes.finish(job, { state: "refused", detail: "Codex owner does not support peer content; update the app" });
  assert.equal(sweepDeliveryFailures(store), 1);
  assert.equal(store.inbox("anonymous").length, 0);
  store.close();
});

test("a live channel host owns delivery for its Claude session", async () => {
  const store = new BridgeStore(":memory:");
  store.wakes.bind("claude-a", { app: "claude", sessionId: "S1" });
  const message = store.send({ fromAgent: "codex", toAgent: "claude-a", body: "ready for review", threadId: "t-1" });

  store.wakes.heartbeatChannel("S1", 424242);
  assert.equal(store.wakes.claim(), null, "another live process hosts S1");
  store.wakes.heartbeatChannel("S1", 424242, Date.now() - 60_000);
  assert.equal(store.wakes.claim()?.messageId, message.id, "a stale host no longer blocks delivery");

  const other = new BridgeStore(":memory:");
  other.wakes.bind("claude-b", { app: "claude", sessionId: "S2" });
  const pushed = other.send({ fromAgent: "codex", toAgent: "claude-b", body: "channel please", threadId: "t-2" });
  const sent: ChannelNotification[] = [];
  const dispatcher = new WakeDispatcher(other, {
    channel: { sessionId: "S2", send: async (notification) => { sent.push(notification); } },
  });
  dispatcher.start();
  await dispatcher.flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.method, CHANNEL_METHOD);
  assert.deepEqual(sent[0]?.params.meta, { message_id: String(pushed.id), recipient: "claude-b", from_agent: "codex", thread_id: "t-2" });
  assert.ok(Object.keys(sent[0]!.params.meta).every((key) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)));
  assert.match(sent[0]?.params.content ?? "", /Bridge message #/);
  assert.equal(other.wakes.forMessage(pushed.id)?.state, "unknown");
  other.wakes.recordRead("claude-b", [pushed.id]);
  assert.equal(other.wakes.forMessage(pushed.id)?.state, "read");
  await dispatcher.close();
  store.close();
  other.close();
});

test("channel mode is opt-in and needs a Claude session", () => {
  assert.equal(channelSession({}), null);
  assert.equal(channelSession({ CLAUDE_CODE_SESSION_ID: "abc" }), null);
  assert.equal(channelSession({ BRIDGE_CLAUDE_CHANNEL: "1" }), null);
  assert.equal(channelSession({ BRIDGE_CLAUDE_CHANNEL: "1", CLAUDE_CODE_SESSION_ID: "abc" }), "abc");
});

test("daily backups happen once per day across processes and keep a week", () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-backup-"));
  const path = join(dir, "bridge.sqlite");
  const first = new BridgeStore(path);
  const second = new BridgeStore(path);
  first.send({ fromAgent: "a", toAgent: "b", body: "keep me" });
  const now = Date.UTC(2026, 8, 22, 12);
  const written = dailyBackup(first, now);
  assert.ok(written?.endsWith("bridge-daily-2026-09-22.sqlite"));
  assert.equal(dailyBackup(second, now + HOUR), null, "only one process backs up per day");
  for (let day = 1; day <= 9; day += 1) dailyBackup(second, now + day * 24 * HOUR);
  const daily = readdirSync(join(dir, "backups")).filter((name) => name.startsWith("bridge-daily-"));
  assert.equal(daily.length, 7);
  assert.ok(daily.includes("bridge-daily-2026-10-01.sqlite"));

  process.env.BRIDGE_BACKUPS = "0";
  try {
    assert.equal(dailyBackup(first, now + 30 * 24 * HOUR), null);
  } finally {
    delete process.env.BRIDGE_BACKUPS;
  }
  first.close();
  second.close();
});

test("old Codex event streams are pruned while result envelopes and other files are kept", () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-runs-"));
  const old = "11111111-1111-4111-8111-111111111111";
  const fresh = "22222222-2222-4222-8222-222222222222";
  const names = [`${old}.json`, `${old}.events.jsonl`, `${old}.stderr.log`, `${fresh}.events.jsonl`, "codex-turn.schema.json", "notes.txt"];
  for (const name of names) writeFileSync(join(dir, name), "{}");
  const past = new Date(Date.now() - 40 * 24 * HOUR);
  for (const name of names.filter((entry) => !entry.startsWith(fresh))) utimesSync(join(dir, name), past, past);
  assert.equal(pruneRunFiles(dir), 2);
  assert.deepEqual(readdirSync(dir).sort(), [`${old}.json`, `${fresh}.events.jsonl`, "codex-turn.schema.json", "notes.txt"].sort());
});

test("the housekeeper sweeps failed pings on its first tick", async () => {
  const store = new BridgeStore(":memory:");
  store.register("sender");
  store.wakes.bind("recipient", { app: "codex", sessionId: "task" });
  store.send({ fromAgent: "sender", toAgent: "recipient", body: "work" });
  const job = store.wakes.claim()!;
  store.wakes.finish(job, { state: "refused", detail: "Codex owner does not support peer content; update the app" });
  const logs: string[] = [];
  await new Housekeeper(store, null, { log: (line) => logs.push(line) }).tick();
  assert.equal(store.inbox("sender").length, 1);
  assert.deepEqual(logs, []);
  store.close();
});
