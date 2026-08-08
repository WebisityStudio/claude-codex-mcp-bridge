import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BridgeStore } from "../src/bridge-store.js";
import { waitForInbox } from "../src/inbox-waiter.js";

function freshStore(): BridgeStore {
  const dir = mkdtempSync(join(tmpdir(), "claude-codex-bridge-wait-"));
  return new BridgeStore(join(dir, "bridge.sqlite"));
}

test("a waiting agent receives a later message without polling manually", async () => {
  const store = freshStore();
  const waiting = waitForInbox(store, {
    agent: "claude-main",
    timeoutMs: 1_000,
    pollIntervalMs: 10,
  });

  setTimeout(() => {
    store.send({
      fromAgent: "codex-main",
      toAgent: "claude-main",
      body: "Implementation complete",
      threadId: "automatic-loop",
    });
  }, 25);

  const result = await waiting;
  assert.equal(result.timedOut, false);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0]?.body, "Implementation complete");
  store.close();
});

test("a waiting agent can restrict delivery to one thread and sender", async () => {
  const store = freshStore();
  store.send({
    fromAgent: "other-agent",
    toAgent: "claude-main",
    body: "Unrelated",
    threadId: "other-thread",
  });
  store.send({
    fromAgent: "codex-main",
    toAgent: "claude-main",
    body: "Expected reply",
    threadId: "automatic-loop",
  });

  const result = await waitForInbox(store, {
    agent: "claude-main",
    fromAgent: "codex-main",
    threadId: "automatic-loop",
    timeoutMs: 100,
    pollIntervalMs: 10,
  });

  assert.deepEqual(result.messages.map((message) => message.body), ["Expected reply"]);
  store.close();
});

test("a wait reports timeout when no matching message arrives", async () => {
  const store = freshStore();
  const result = await waitForInbox(store, {
    agent: "codex-main",
    timeoutMs: 30,
    pollIntervalMs: 5,
  });

  assert.equal(result.timedOut, true);
  assert.deepEqual(result.messages, []);
  store.close();
});
