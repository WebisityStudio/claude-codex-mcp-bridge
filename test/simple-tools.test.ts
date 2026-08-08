import assert from "node:assert/strict";
import test from "node:test";

import { buildAskCodexTask, buildCodexReviewTask } from "../src/simple-tools.js";

test("ask_codex preserves the user's task and applies safety boundaries", () => {
  const task = buildAskCodexTask("Investigate why the tests are flaky");
  assert.match(task, /Investigate why the tests are flaky/);
  assert.match(task, /Do not commit, push, merge, deploy, publish/);
});

test("review_with_codex is explicitly read-only and returns actionable evidence", () => {
  const task = buildCodexReviewTask("Focus on authentication and data isolation.");
  assert.match(task, /Review only/);
  assert.match(task, /Do not edit files/);
  assert.match(task, /authentication and data isolation/);
  assert.match(task, /file and line references/);
});
