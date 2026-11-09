import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CODEX_TOOL_TIMEOUT_SEC,
  buildRegistrationPlan,
  newestVersion,
  parseCliCommand,
  resolveClaudeBinary,
  resolveSkillTargets,
  supportedNode,
} from "../src/cli-logic.js";
import { bundledClaudeBinary, bundledClaudeRoot } from "../src/claude-binary.js";
import { codexConfigPath, readCodexServerEntry, updateCodexServerEntry } from "../src/codex-config.js";
import { defaultDbPath, runtimePrefix, worktreeRoot } from "../src/paths.js";
import {
  activateVersion,
  currentVersion,
  listVersions,
  previousVersion,
  runtimeLayout,
  versionId,
  versionsToPrune,
} from "../src/runtime.js";
import { VERSION } from "../src/version.js";

test("setup plan registers the same built server with Claude and Codex", () => {
  const plan = buildRegistrationPlan({
    packageRoot: "/opt/claude-codex-mcp-bridge",
    nodeBinary: "/usr/bin/node",
  });
  const server = join("/opt/claude-codex-mcp-bridge", "dist", "server.js");
  assert.deepEqual(plan.claude.add, ["claude", "mcp", "add", "--scope", "user", "claude-codex-bridge", "--", "/usr/bin/node", server]);
  assert.deepEqual(plan.codex.add, ["codex", "mcp", "add", "claude-codex-bridge", "--", "/usr/bin/node", server]);
});

test("CLI parser recognises commands, flags, values and bad input", () => {
  assert.equal(parseCliCommand(["setup", "--force"]).force, true);
  assert.equal(parseCliCommand(["uninstall", "--purge"]).purge, true);
  assert.equal(parseCliCommand(["doctor", "--fix"]).fix, true);
  const retire = parseCliCommand(["retire", "opus-worker", "--note", "task merged", "--keep-backlog"]);
  assert.deepEqual([retire.command, retire.target, retire.note, retire.keepBacklog], ["retire", "opus-worker", "task merged", true]);
  const prune = parseCliCommand(["prune", "--older-than=3d", "--apply"]);
  assert.deepEqual([prune.command, prune.olderThanDays, prune.apply], ["prune", 3, true]);
  assert.equal(parseCliCommand(["-h"]).command, "help");
  assert.equal(parseCliCommand([]).command, "help");
  assert.throws(() => parseCliCommand(["unknown"]), /Unknown command/);
  assert.throws(() => parseCliCommand(["setup", "--nope"]), /Unknown option/);
  assert.throws(() => parseCliCommand(["retire"]), /needs an agent/);
  assert.throws(() => parseCliCommand(["prune", "--older-than", "soon"]), /positive number/);
  assert.throws(() => parseCliCommand(["status", "extra", "more"]), /Unexpected argument/);
});

test("setup prefers the newest desktop-bundled Claude Code", () => {
  assert.equal(newestVersion(["2.1.275", "2.1.280", "2.1.99", "junk"]), "2.1.280");
  assert.equal(resolveClaudeBinary({ bundled: "/bundle/2.1.280/claude" }), "/bundle/2.1.280/claude");
  assert.equal(resolveClaudeBinary({ configured: "/custom/claude", bundled: "/bundle/2.1.280/claude" }), "/custom/claude");
  assert.equal(resolveClaudeBinary({ bundled: null }), "claude");

  // The desktop app has shipped Claude Code as <version>/claude.app and as <version>/<build>/claude.app.
  const root = mkdtempSync(join(tmpdir(), "bundled-claude-"));
  const binary = (...parts: string[]) => join(root, ...parts, "claude.app", "Contents", "MacOS", "claude");
  const install = (...parts: string[]) => {
    mkdirSync(join(binary(...parts), ".."), { recursive: true });
    writeFileSync(binary(...parts), "");
  };
  assert.equal(bundledClaudeBinary(root), null);
  install("2.1.99");
  assert.equal(bundledClaudeBinary(root), binary("2.1.99"));
  install("2.1.309", "5af865b9901c");
  install("2.1.317", "91184d3d9ba3");
  mkdirSync(join(root, "2.1.400"), { recursive: true }); // A version folder still downloading.
  assert.equal(bundledClaudeBinary(root), binary("2.1.317", "91184d3d9ba3"), "the nested layout is found and the newest complete version wins");
  assert.equal(bundledClaudeBinary(join(root, "missing")), null);
  assert.equal(bundledClaudeBinary(null), null);
  assert.equal(bundledClaudeRoot("/Users/me", "linux"), null);
  assert.equal(bundledClaudeRoot("/Users/me", "darwin"), join("/Users/me", "Library", "Application Support", "Claude", "claude-code"));

  assert.equal(parseCliCommand(["setup", "--node", "/opt/homebrew/bin/node"]).node, "/opt/homebrew/bin/node");
  const plan = buildRegistrationPlan({ packageRoot: "/p", nodeBinary: "/n", claudeBinary: "/bundle/claude" });
  assert.equal(plan.claude.add[0], "/bundle/claude");
});

test("Node.js security baseline accepts patched stable releases on supported lines", () => {
  for (const version of [
    "v22.23.4", "22.23.4", "v22.23.5", "v22.24.0",
    "v24.22.1", "24.22.1", "v24.22.2", "v24.23.0",
    "v26.12.1", "26.12.1", "v26.12.2", "v26.13.0",
  ]) {
    assert.equal(supportedNode(version), true, version);
  }
});

test("Node.js security baseline rejects unpatched and unsupported release lines", () => {
  for (const version of [
    "v22.5.0", "v22.23.3", "v22.22.99",
    "v24.22.0", "v24.21.99", "v26.12.0", "v26.11.99",
    "v20.99.99", "v23.99.99", "v25.99.99", "v27.0.0", "v28.0.0",
  ]) {
    assert.equal(supportedNode(version), false, version);
  }
});

test("Node.js security baseline rejects prereleases and invalid version output", () => {
  for (const version of [
    "v22.23.4-rc.1", "v24.22.1-nightly", "v26.12.1-pre", "v26.13.0-rc.1",
    "v26.12.1+custom", "", "node v26.12.1", "v26.12", "26", "v26.12.1.0",
    "v026.12.1", "v26.012.1", "v26.12.01", "v26.12.1junk", " v26.12.1",
    "v26.12.1\n", "v26.9007199254740992.0",
  ]) {
    assert.equal(supportedNode(version), false, JSON.stringify(version));
  }
});

test("paths honour overrides and default to the per-user data directory", () => {
  const home = "/Users/example";
  assert.equal(runtimePrefix({}, home), join(home, ".local", "share", "claude-codex-bridge", "runtime"));
  assert.equal(defaultDbPath({}, home), join(home, ".local", "share", "claude-codex-bridge", "bridge.sqlite"));
  assert.equal(defaultDbPath({ XDG_DATA_HOME: "/data" }, home), join("/data", "claude-codex-bridge", "bridge.sqlite"));
  assert.equal(defaultDbPath({ BRIDGE_DB_PATH: "/tmp/x.sqlite" }, home), "/tmp/x.sqlite");
  assert.equal(worktreeRoot({ BRIDGE_WORKTREE_ROOT: "/wt" }, home), "/wt");
  assert.equal(codexConfigPath({ CODEX_HOME: "/codex" }, home), join("/codex", "config.toml"));
  assert.equal(codexConfigPath({}, home), join(home, ".codex", "config.toml"));
});

test("skill targets cover Claude and the shared agent-skills directory", () => {
  assert.deepEqual(resolveSkillTargets("/Users/example"), [
    join("/Users/example", ".claude", "skills"),
    join("/Users/example", ".agents", "skills"),
  ]);
});

const CODEX_CONFIG = `model = "example-model"

[mcp_servers.other]
command = "/bin/other"
args = ["--keep"]

[mcp_servers.claude-codex-bridge]
command = "/opt/homebrew/bin/node"
args = ["/Users/me/checkout/dist/server.js"]
enabled = true

[mcp_servers.claude-codex-bridge.tools.bridge_wait]
approval_mode = "approve"

[mcp_servers.claude-codex-bridge.tools.bridge_send]
approval_mode = "approve"

[notice]
hide_full_access_warning = true
`;

test("Codex config edits keep per-tool approvals and add a long enough tool timeout", () => {
  const before = readCodexServerEntry(CODEX_CONFIG, "claude-codex-bridge");
  assert.deepEqual(before, {
    found: true,
    command: "/opt/homebrew/bin/node",
    args: ["/Users/me/checkout/dist/server.js"],
    toolTimeoutSec: null,
  });
  const update = { command: "/opt/homebrew/bin/node", args: ["/runtime/current/server.js"], toolTimeoutSec: CODEX_TOOL_TIMEOUT_SEC };
  const updated = updateCodexServerEntry(CODEX_CONFIG, "claude-codex-bridge", update);
  assert.ok(updated?.changed);
  const text = updated!.text;
  assert.match(text, /args = \["\/runtime\/current\/server.js"\]\ntool_timeout_sec = 300\nenabled = true/);
  assert.equal((text.match(/approval_mode = "approve"/g) ?? []).length, 2, "tool approvals survive");
  assert.match(text, /\[mcp_servers\.other\]\ncommand = "\/bin\/other"\nargs = \["--keep"\]/);
  assert.match(text, /hide_full_access_warning = true/);
  assert.equal(updateCodexServerEntry(text, "claude-codex-bridge", update)?.changed, false, "idempotent");
  assert.equal(readCodexServerEntry(text, "claude-codex-bridge").toolTimeoutSec, 300);

  const custom = CODEX_CONFIG.replace("enabled = true", "tool_timeout_sec = 900\nenabled = true");
  assert.match(updateCodexServerEntry(custom, "claude-codex-bridge", update)!.text, /tool_timeout_sec = 900/);

  const multiline = `[mcp_servers."claude-codex-bridge"]\ncommand = "node"\nargs = [\n  "/old/server.js", # comment\n  "--flag",\n]\n`;
  const rewritten = updateCodexServerEntry(multiline, "claude-codex-bridge", { command: "node", args: ["/new/server.js"] });
  assert.equal(rewritten?.text, `[mcp_servers."claude-codex-bridge"]\ncommand = "node"\nargs = ["/new/server.js"]\n`);
  assert.equal(updateCodexServerEntry("[mcp_servers.other]\ncommand = \"x\"\n", "claude-codex-bridge", update), null);
});

test("runtime versions sort, roll back and prune while keeping current and previous", () => {
  const id = versionId("0.4.0", new Date("2026-09-22T21:40:05.123Z"));
  assert.equal(id, "20260922T214005Z-v0.4.0");
  const ids = ["20260930T000000Z-v0.6.0", "20260925T000000Z-v0.5.0", "20260922T000000Z-v0.4.0", "20260901T000000Z-v0.3.0"];
  assert.equal(previousVersion(ids, ids[0]), ids[1]);
  assert.equal(previousVersion(ids, ids[3]), null);
  assert.deepEqual(versionsToPrune(ids, ids[0], 3), [ids[3]]);
  // After a rollback to 0.4.0, both 0.4.0 and the older 0.3.0 stay available.
  assert.deepEqual(versionsToPrune(ids, ids[2], 3), [ids[1]]);
});

test("activating a runtime version swaps the current link atomically", { skip: process.platform === "win32" }, () => {
  const prefix = realpathSync(mkdtempSync(join(tmpdir(), "bridge-runtime-")));
  const layout = runtimeLayout(prefix);
  for (const id of ["20260901T000000Z-v0.3.0", "20260922T000000Z-v0.4.0"]) {
    mkdirSync(join(layout.versionsDir, id, "node_modules", "claude-codex-mcp-bridge", "dist"), { recursive: true });
    writeFileSync(join(layout.versionsDir, id, "node_modules", "claude-codex-mcp-bridge", "dist", "server.js"), `// ${id}`);
  }
  assert.equal(currentVersion(layout), null);
  activateVersion(layout, "20260922T000000Z-v0.4.0");
  assert.equal(currentVersion(layout), "20260922T000000Z-v0.4.0");
  const server = join(layout.currentLink, "node_modules", "claude-codex-mcp-bridge", "dist", "server.js");
  assert.match(readFileSync(server, "utf8"), /v0.4.0/);
  activateVersion(layout, previousVersion(listVersions(layout), currentVersion(layout)) as string);
  assert.match(readFileSync(server, "utf8"), /v0.3.0/);
  assert.equal(existsSync(`${layout.currentLink}.next-${process.pid}`), false);
  assert.throws(() => activateVersion(layout, "missing"), /not installed/);
});

test("the reported version matches package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(VERSION, pkg.version);
});
