import assert from "node:assert/strict";
import test from "node:test";

import { agentNameProblem, checkRecipient, editDistance, suggestNames } from "../src/addressing.js";
import { BridgeStore } from "../src/bridge-store.js";
import { findStaleAgents, retireAgent } from "../src/lifecycle.js";

const DAY = 24 * 3_600_000;

function failPings(store: BridgeStore, from: string, to: string, count: number, detail: string): void {
  for (let index = 0; index < count; index += 1) {
    store.send({ fromAgent: from, toAgent: to, body: `ping ${index}` });
    const job = store.wakes.claim();
    assert.ok(job);
    store.wakes.finish(job, { state: "refused", detail });
  }
}

test("agent names reject reserved words, session IDs and stray whitespace", () => {
  assert.equal(agentNameProblem("review-claude"), null);
  assert.match(agentNameProblem("bridge") ?? "", /reserved/);
  assert.match(agentNameProblem("*") ?? "", /reserved/);
  assert.match(agentNameProblem("01900000-0000-7000-8000-000000000000") ?? "", /session ID/);
  assert.match(agentNameProblem(" padded") ?? "", /spaces/);
});

test("name suggestions catch typos and partial names", () => {
  assert.equal(editDistance("kitten", "sitting"), 3);
  const names = ["codex-main", "claude-main", "review-worker-20260101"];
  assert.deepEqual(suggestNames("codex", names), ["codex-main"]);
  assert.deepEqual(suggestNames("review-worker-20260102", names), ["review-worker-20260101"]);
  assert.deepEqual(suggestNames("totally-different", names), []);
});

test("sending to unknown or retired agents fails with guidance unless explicitly allowed", async () => {
  const store = new BridgeStore(":memory:");
  store.register("codex-main");
  const unknown = await checkRecipient(store, "codx-main");
  assert.equal(unknown.ok, false);
  assert.match(unknown.error ?? "", /Did you mean: codex-main/);
  assert.match(unknown.error ?? "", /allowUnregistered/);

  const session = await checkRecipient(store, "01900000-0000-7000-8000-000000000000");
  assert.match(session.error ?? "", /looks like a session ID/);

  const later = await checkRecipient(store, "future-agent", { allowUnregistered: true });
  assert.equal(later.ok, true);
  assert.match(later.warnings[0] ?? "", /No agent named/);

  retireAgent(store, "codex-main", { by: "operator", note: "task merged" });
  const retired = await checkRecipient(store, "codex-main");
  assert.equal(retired.ok, false);
  assert.match(retired.error ?? "", /retired .* by operator \(task merged\)/);
  store.close();
});

test("senders are warned when pings keep failing or the recipient looks idle", async () => {
  const store = new BridgeStore(":memory:");
  store.register("sender");
  store.register("claude-worker");
  store.wakes.bind("claude-worker", { app: "claude", sessionId: "gone-session" });
  failPings(store, "sender", "claude-worker", 3, "Claude expired this peer message");
  const check = await checkRecipient(store, "claude-worker", { isClaudeSessionLive: async () => false });
  assert.equal(check.ok, true);
  assert.ok(check.warnings.some((warning) => /last 3 background pings/.test(warning) && /crossSessionInbound/.test(warning)));
  assert.ok(check.warnings.some((warning) => /session is not running/.test(warning)));

  store.register("quiet-agent");
  const idle = await checkRecipient(store, "quiet-agent", { now: Date.now() + 3 * DAY });
  assert.ok(idle.warnings.some((warning) => /no background ping binding and was last active/.test(warning)));
  store.close();
});

test("registration keeps capabilities when omitted and reactivates retired agents", () => {
  const store = new BridgeStore(":memory:");
  store.register("worker", ["review"]);
  assert.deepEqual(store.register("worker").capabilities, ["review"]);
  retireAgent(store, "worker", { by: "operator" });
  assert.equal(store.agents().length, 0);
  assert.equal(store.agents({ includeRetired: true }).length, 1);
  const back = store.register("worker");
  assert.equal(back.retiredAt, null);
  assert.equal(store.agents().length, 1);
  store.close();
});

test("retiring an agent closes its backlog with a reason and notifies active senders once", () => {
  const store = new BridgeStore(":memory:");
  for (const name of ["coordinator", "helper", "worker"]) store.register(name);
  store.wakes.bind("worker", { app: "codex", sessionId: "task-1" });
  store.send({ fromAgent: "coordinator", toAgent: "worker", body: "do A", wake: false });
  store.send({ fromAgent: "helper", toAgent: "worker", body: "do B", wake: false });
  const pending = store.send({ fromAgent: "helper", toAgent: "worker", body: "do C" });
  assert.equal(store.wakes.forMessage(pending.id)?.state, "pending");

  const result = retireAgent(store, "worker", { by: "coordinator", note: "merged" });
  assert.equal(result.closed, 3);
  assert.equal(result.unbound, true);
  assert.deepEqual(result.notified, ["helper"], "the retiring agent is not notified about itself");
  assert.equal(store.inbox("worker").length, 0);
  assert.equal(store.wakes.target("worker"), null);
  assert.equal(store.wakes.forMessage(pending.id)?.state, "cancelled");
  const notice = store.inbox("helper")[0];
  assert.equal(notice?.fromAgent, "bridge");
  assert.match(notice?.body ?? "", /2 of your messages/);
  assert.match(notice?.body ?? "", /Do not reply/);
  assert.equal(store.inbox("worker", { includeAcknowledged: true }).length, 3, "history is kept");

  // Senders idle for more than a week are not notified.
  store.register("worker-2");
  store.send({ fromAgent: "helper", toAgent: "worker-2", body: "old" });
  const quiet = retireAgent(store, "worker-2", { by: "operator", now: Date.now() + 8 * DAY });
  assert.deepEqual(quiet.notified, []);
  store.close();
});

test("the outbox shows what recipients have not handled, with ping state", () => {
  const store = new BridgeStore(":memory:");
  store.register("sender");
  store.register("bound");
  store.wakes.bind("bound", { app: "codex", sessionId: "task" });
  const first = store.send({ fromAgent: "sender", toAgent: "bound", body: "first" });
  store.send({ fromAgent: "sender", toAgent: "bound", body: "second" });
  store.send({ fromAgent: "sender", toAgent: "ghost", body: "lost" });
  store.send({ fromAgent: "sender", toAgent: "*", body: "broadcast" });
  store.ack("bound", [first.id]);

  const outbox = store.outbox("sender");
  assert.equal(outbox.totalUnacknowledged, 2);
  assert.deepEqual(outbox.entries.map((entry) => entry.preview), ["lost", "second"]);
  assert.equal(outbox.entries[0]?.recipient, "unknown");
  assert.equal(outbox.entries[1]?.recipient, "active");
  assert.equal(outbox.entries[1]?.wake?.state, "pending");
  assert.equal(store.outbox("sender", { includeAcknowledged: true }).entries.length, 3);
  store.close();
});

test("inbox pages stay inside the output budget and can be resumed", () => {
  const store = new BridgeStore(":memory:");
  for (let index = 1; index <= 30; index += 1) store.send({ fromAgent: "a", toAgent: "b", body: `message ${index}` });
  const first = store.inboxPage("b", { limit: 10 });
  assert.equal(first.count, 10);
  assert.equal(first.totalUnread, 30);
  assert.equal(first.hasMore, true);
  const second = store.inboxPage("b", { limit: 10, afterId: first.nextAfterId ?? 0 });
  assert.equal(second.messages[0]?.body, "message 11");

  const big = new BridgeStore(":memory:");
  for (let index = 0; index < 5; index += 1) big.send({ fromAgent: "a", toAgent: "b", body: "x".repeat(10_000) });
  const budgeted = big.inboxPage("b", { maxChars: 25_000 });
  assert.equal(budgeted.count, 2);
  assert.equal(budgeted.hasMore, true);

  big.send({ fromAgent: "a", toAgent: "c", body: "y".repeat(60_000) });
  const oversized = big.inboxPage("c");
  assert.equal(oversized.count, 1);
  assert.equal(oversized.messages[0]?.bodyTruncated, true);
  assert.equal(oversized.messages[0]?.bodyLength, 60_000);
  assert.ok((oversized.messages[0]?.body.length ?? 0) < 48_000);

  const preview = big.inboxPage("b", { maxBodyChars: 50 });
  assert.equal(preview.count, 5);
  assert.equal(preview.messages[0]?.body.length, 50);
  store.close();
  big.close();
});

test("thread pages start at the newest messages and page in both directions", () => {
  const store = new BridgeStore(":memory:");
  for (let index = 1; index <= 50; index += 1) {
    store.send({ fromAgent: index % 2 ? "a" : "b", toAgent: index % 2 ? "b" : "a", body: `m${index}`, threadId: "long" });
  }
  const tail = store.threadPage("long");
  assert.equal(tail.total, 50);
  assert.equal(tail.count, 30);
  assert.equal(tail.messages[0]?.body, "m21");
  assert.equal(tail.messages.at(-1)?.body, "m50");
  assert.equal(tail.olderBeforeId, tail.messages[0]?.id);
  assert.equal(tail.newerAfterId, null);

  const older = store.threadPage("long", { beforeId: tail.olderBeforeId ?? 0 });
  assert.equal(older.messages[0]?.body, "m1");
  assert.equal(older.messages.at(-1)?.body, "m20");
  assert.equal(older.olderBeforeId, null);

  const forward = store.threadPage("long", { afterId: 40, limit: 5 });
  assert.deepEqual(forward.messages.map((message) => message.body), ["m41", "m42", "m43", "m44", "m45"]);
  assert.equal(forward.newerAfterId, 45);
  store.close();
});

test("stale agents are those idle past the window, except live Claude sessions", async () => {
  const store = new BridgeStore(":memory:");
  store.register("idle");
  store.register("live-claude");
  store.wakes.bind("live-claude", { app: "claude", sessionId: "alive" });
  store.send({ fromAgent: "x", toAgent: "idle", body: "waiting" });
  const stale = await findStaleAgents(store, {
    olderThanMs: 7 * DAY,
    now: Date.now() + 10 * DAY,
    isClaudeSessionLive: async (sessionId) => sessionId === "alive",
  });
  assert.deepEqual(stale.map((agent) => agent.name), ["idle"]);
  assert.equal(stale[0]?.unread, 1);
  assert.deepEqual(await findStaleAgents(store, { olderThanMs: 7 * DAY }), []);
  store.close();
});

test("acknowledged messages never count as unread or get closed again", () => {
  const store = new BridgeStore(":memory:");
  store.register("worker");
  const handled = store.send({ fromAgent: "lead", toAgent: "worker", body: "done already" });
  store.send({ fromAgent: "lead", toAgent: "worker", body: "still open" });
  store.ack("worker", [handled.id]);
  assert.equal(store.countUnread("worker"), 1);
  assert.equal(store.agentSummaries().find((agent) => agent.name === "worker")?.unread, 1);
  assert.equal(retireAgent(store, "worker", { by: "lead" }).closed, 1);
  store.close();
});
