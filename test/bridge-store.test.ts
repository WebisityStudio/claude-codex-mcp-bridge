import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BridgeStore } from "../src/bridge-store.js";

function freshStore(): BridgeStore {
  const dir = mkdtempSync(join(tmpdir(), "claude-codex-bridge-"));
  return new BridgeStore(join(dir, "bridge.sqlite"));
}

test("a direct message appears only in the recipient inbox", () => {
  const store = freshStore();
  const sent = store.send({ fromAgent: "claude", toAgent: "codex", body: "Review auth.ts" });

  assert.equal(sent.id, 1);
  assert.equal(store.inbox("codex").length, 1);
  assert.equal(store.inbox("claude").length, 0);
  assert.equal(store.inbox("codex")[0]?.body, "Review auth.ts");
  store.close();
});

test("broadcast messages are visible to every other agent", () => {
  const store = freshStore();
  store.send({ fromAgent: "claude", toAgent: "*", body: "Build is green" });

  assert.equal(store.inbox("codex").length, 1);
  assert.equal(store.inbox("reviewer").length, 1);
  assert.equal(store.inbox("claude").length, 0);
  store.close();
});

test("acknowledged messages leave the unread inbox but remain in thread history", () => {
  const store = freshStore();
  const sent = store.send({
    fromAgent: "codex",
    toAgent: "claude",
    body: "Found one race condition",
    threadId: "auth-review",
  });

  assert.equal(store.ack("claude", [sent.id]), 1);
  assert.equal(store.inbox("claude").length, 0);
  assert.equal(store.inbox("claude", { includeAcknowledged: true }).length, 1);
  assert.equal(store.thread("auth-review").length, 1);
  store.close();
});

test("an agent cannot acknowledge a message that was not delivered to it", () => {
  const store = freshStore();
  const sent = store.send({ fromAgent: "claude", toAgent: "codex", body: "Private" });

  assert.equal(store.ack("reviewer", [sent.id]), 0);
  assert.equal(store.inbox("codex").length, 1);
  store.close();
});

test("idempotency keys prevent duplicate delivery", () => {
  const store = freshStore();
  const first = store.send({
    fromAgent: "claude",
    toAgent: "codex",
    body: "Please inspect the diff",
    idempotencyKey: "review-42",
  });
  const duplicate = store.send({
    fromAgent: "claude",
    toAgent: "codex",
    body: "Please inspect the diff",
    idempotencyKey: "review-42",
  });

  assert.equal(duplicate.id, first.id);
  assert.equal(store.inbox("codex").length, 1);
  store.close();
});

test("agents can register presence and report capabilities", () => {
  const store = freshStore();
  store.register("claude", ["architecture", "review"]);
  store.register("codex", ["implementation"]);

  const agents = store.agents();
  assert.deepEqual(agents.map((agent) => agent.name), ["claude", "codex"]);
  assert.deepEqual(agents[0]?.capabilities, ["architecture", "review"]);
  store.close();
});
