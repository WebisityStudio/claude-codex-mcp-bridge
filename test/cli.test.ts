import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import {
  buildRegistrationPlan,
  parseCliCommand,
  resolveRuntimePrefix,
  resolveSkillTargets,
} from "../src/cli-logic.js";

test("setup plan registers the same built server with Claude and Codex", () => {
  const plan = buildRegistrationPlan({
    packageRoot: "/opt/claude-codex-mcp-bridge",
    nodeBinary: "/usr/bin/node",
  });

  assert.deepEqual(plan.claude.add, [
    "claude",
    "mcp",
    "add",
    "--scope",
    "user",
    "claude-codex-bridge",
    "--",
    "/usr/bin/node",
    join("/opt/claude-codex-mcp-bridge", "dist", "server.js"),
  ]);
  assert.deepEqual(plan.codex.add, [
    "codex",
    "mcp",
    "add",
    "claude-codex-bridge",
    "--",
    "/usr/bin/node",
    join("/opt/claude-codex-mcp-bridge", "dist", "server.js"),
  ]);
});

test("CLI command parser recognises supported commands and safe flags", () => {
  assert.deepEqual(parseCliCommand(["setup", "--force"]), {
    command: "setup",
    force: true,
    purge: false,
  });
  assert.deepEqual(parseCliCommand(["uninstall", "--purge"]), {
    command: "uninstall",
    force: false,
    purge: true,
  });
  assert.throws(() => parseCliCommand(["unknown"]), /Unknown command/);
});

test("runtime installation uses a stable user-owned prefix", () => {
  assert.equal(
    resolveRuntimePrefix("/Users/example"),
    join("/Users/example", ".local", "share", "claude-codex-bridge", "runtime"),
  );
});

test("skill targets cover Claude and the shared agent-skills directory", () => {
  assert.deepEqual(resolveSkillTargets("/Users/example"), [
    join("/Users/example", ".claude", "skills"),
    join("/Users/example", ".agents", "skills"),
  ]);
});
