import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_POLICY,
  checkWorkerRequest,
  loadPolicy,
  parsePolicy,
  policyPath,
  type WorkerPolicy,
  type WorkerRequest,
} from "../src/worker-policy.js";

const codex = (extra: Partial<WorkerRequest> = {}): WorkerRequest => ({ worker: "codex", projectPath: "/repo", startsLastHour: 0, ...extra });
const claude = (extra: Partial<WorkerRequest> = {}): WorkerRequest => ({ worker: "claude", projectPath: "/repo", startsLastHour: 0, ...extra });

test("the default ceiling allows ordinary worker chats and nothing with full access", () => {
  assert.deepEqual(checkWorkerRequest(DEFAULT_POLICY, codex()), { showInDesktop: false, warnings: [] });
  checkWorkerRequest(DEFAULT_POLICY, codex({ model: "gpt-5.6-luna", effort: "high", sandbox: "workspace-write" }));
  checkWorkerRequest(DEFAULT_POLICY, claude({ model: "haiku", effort: "low", permissionMode: "acceptEdits" }));

  assert.throws(() => checkWorkerRequest(DEFAULT_POLICY, codex({ effort: "xhigh" })), /higher than Codex workers may use \(up to "high"\)/);
  assert.throws(() => checkWorkerRequest(DEFAULT_POLICY, claude({ permissionMode: "auto" })), /more autonomy than Claude workers may have \(up to "acceptEdits"\)/);
  assert.throws(
    () => checkWorkerRequest(DEFAULT_POLICY, codex({ sandbox: "danger-full-access" as never })),
    /Workers run in one of these sandboxes: read-only, workspace-write/,
  );
  assert.throws(
    () => checkWorkerRequest(DEFAULT_POLICY, claude({ permissionMode: "bypassPermissions" as never })),
    /one of these permission modes: plan, manual, acceptEdits, auto/,
  );
  assert.throws(() => checkWorkerRequest(DEFAULT_POLICY, codex({ effort: "ludicrous" })), /not a reasoning effort/);
  assert.throws(() => checkWorkerRequest(DEFAULT_POLICY, codex({ model: "--dangerous flag" })), /not a valid model name/);
});

test("a refusal names the limit and says a tool call cannot change it", () => {
  assert.throws(
    () => checkWorkerRequest(DEFAULT_POLICY, codex({ startsLastHour: 12 })),
    /12 worker chats were started through this bridge in the last hour \(limit 12\).*default policy.*a tool call cannot change it/s,
  );
  assert.throws(() => checkWorkerRequest(DEFAULT_POLICY, claude({ effort: "max" }), "/data/policy.json"), /the owner's policy \(\/data\/policy\.json\)/);
});

test("the owner can narrow models, effort, permissions and folders", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "bridge-policy-")));
  mkdirSync(join(base, "work", "repo"), { recursive: true });
  mkdirSync(join(base, "elsewhere"));
  const policy: WorkerPolicy = parsePolicy({
    maxStartsPerHour: 2,
    allowedRoots: [join(base, "work")],
    codex: { allowedModels: ["gpt-5.6-luna"], maxEffort: "medium", maxSandbox: "read-only" },
    claude: { allowedModels: ["haiku", "sonnet"], maxEffort: "low", maxPermissionMode: "plan", showInDesktop: "never" },
  });
  const inside = join(base, "work", "repo");

  checkWorkerRequest(policy, codex({ projectPath: inside, model: "gpt-5.6-luna", effort: "medium", sandbox: "read-only" }));
  checkWorkerRequest(policy, codex({ projectPath: join(base, "work") })); // The root itself is allowed.
  assert.throws(() => checkWorkerRequest(policy, codex({ projectPath: join(base, "elsewhere") })), /outside the folders workers may be started in/);
  assert.throws(() => checkWorkerRequest(policy, codex({ projectPath: join(base, "work-other") })), /outside the folders/, "a sibling with the same prefix is not inside");
  assert.throws(() => checkWorkerRequest(policy, codex({ projectPath: inside, model: "gpt-6.1-sol" })), /may use only these models: gpt-5\.6-luna/);
  assert.throws(() => checkWorkerRequest(policy, codex({ projectPath: inside, sandbox: "workspace-write" })), /more access than Codex workers may have \(up to "read-only"\)/);
  assert.throws(() => checkWorkerRequest(policy, claude({ projectPath: inside, permissionMode: "manual" })), /up to "plan"/);
  assert.throws(() => checkWorkerRequest(policy, claude({ projectPath: inside, startsLastHour: 2 })), /limit 2/);

  const refusedHandoff = checkWorkerRequest(policy, claude({ projectPath: inside, showInDesktop: true }));
  assert.equal(refusedHandoff.showInDesktop, false);
  assert.match(refusedHandoff.warnings.join(" "), /will not be opened in the Claude desktop app/);
});

test("opening a Claude chat in the desktop app follows the owner's setting", () => {
  const ask = (mode: "never" | "on-request" | "always", requested: boolean | undefined) =>
    checkWorkerRequest({ ...DEFAULT_POLICY, claude: { ...DEFAULT_POLICY.claude, showInDesktop: mode } }, claude({ showInDesktop: requested })).showInDesktop;
  assert.equal(ask("on-request", undefined), false);
  assert.equal(ask("on-request", true), true);
  assert.equal(ask("always", undefined), true);
  assert.equal(ask("always", false), true);
  assert.equal(ask("never", true), false);
  assert.equal(checkWorkerRequest(DEFAULT_POLICY, codex({ showInDesktop: true })).showInDesktop, false, "Codex chats are listed by the Codex app itself");
});

test("a missing policy file means the defaults; a broken one is refused, never ignored", () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-policy-file-"));
  const path = join(dir, "policy.json");
  assert.deepEqual(loadPolicy(path), { policy: DEFAULT_POLICY, source: null });

  writeFileSync(path, JSON.stringify({ maxStartsPerHour: 3, claude: { maxPermissionMode: "manual" } }));
  const loaded = loadPolicy(path);
  assert.equal(loaded.source, path);
  assert.equal(loaded.policy.maxStartsPerHour, 3);
  assert.equal(loaded.policy.claude.maxPermissionMode, "manual");
  assert.equal(loaded.policy.claude.maxEffort, "high", "unset limits keep their defaults");
  assert.equal(loaded.policy.codex.maxSandbox, "workspace-write");

  for (const [broken, problem] of [
    ["{ not json", /not readable JSON/],
    [JSON.stringify({ maxStartsPerHour: "many" }), /maxStartsPerHour must be a whole number/],
    [JSON.stringify({ codex: { maxSandbox: "danger-full-access" } }), /codex\.maxSandbox must be one of read-only, workspace-write/],
    [JSON.stringify({ claude: { maxPermissionMode: "bypassPermissions" } }), /claude\.maxPermissionMode must be one of plan, manual, acceptEdits, auto/],
    [JSON.stringify({ claude: { maxPermisionMode: "plan" } }), /unknown setting claude\.maxPermisionMode/],
    [JSON.stringify({ allowedRoots: ["relative/path"] }), /allowedRoots must be a list of valid/],
    [JSON.stringify([]), /the file must be an object/],
  ] as const) {
    writeFileSync(path, broken);
    assert.throws(() => loadPolicy(path), problem);
    assert.throws(() => loadPolicy(path), /Fix it or remove it to use the defaults/);
  }
});

test("the policy file lives in the bridge data directory unless overridden", () => {
  assert.equal(policyPath({ XDG_DATA_HOME: "/data" }), join("/data", "claude-codex-bridge", "policy.json"));
  assert.equal(policyPath({ BRIDGE_POLICY_PATH: "/etc/bridge-policy.json", XDG_DATA_HOME: "/data" }), "/etc/bridge-policy.json");
});
