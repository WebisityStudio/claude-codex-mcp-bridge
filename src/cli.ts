#!/usr/bin/env node

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

import { BridgeStore } from "./bridge-store.js";
import { claudeSessions } from "./claude-wake.js";
import { codexConfigPath, readCodexServerEntry, updateCodexServerEntry } from "./codex-config.js";
import { crossSessionInbound, inspectDatabase } from "./diagnostics.js";
import { ensurePrivateDirectory, modeString, restrictToOwner } from "./fs-safety.js";
import { waitForInbox } from "./inbox-waiter.js";
import { findStaleAgents, retireAgent } from "./lifecycle.js";
import { CLAUDE_HOLD_EXPLANATION } from "./notices.js";
import { resolveCodexBinary } from "./orchestrator.js";
import { dataDir, defaultDbPath, runsDir, runtimePrefix } from "./paths.js";
import {
  activateVersion,
  currentPackageRoot,
  currentVersion,
  listVersions,
  packageRootIn,
  previousVersion,
  removeVersions,
  runtimeLayout,
  serverPathFor,
  versionId,
  versionsToPrune,
} from "./runtime.js";
import { SCHEMA_VERSION } from "./schema.js";
import {
  CODEX_TOOL_TIMEOUT_SEC,
  MCP_NAME,
  buildRegistrationPlan,
  parseCliCommand,
  resolveClaudeBinary,
  resolveSkillTargets,
  supportedNode,
  type ParsedCliCommand,
} from "./cli-logic.js";
import { VERSION } from "./version.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const layout = runtimeLayout(runtimePrefix());
const stableRoot = currentPackageRoot(layout);
const stableServer = serverPathFor(stableRoot);
const dbPath = defaultDbPath();
const SKILLS = ["ask-codex", "review-with-codex", "claude-codex-coordinator"];
const REQUIRED_TOOLS = ["bridge_register", "bridge_send", "bridge_inbox", "bridge_outbox", "ask_codex", "bridge_orchestration_wait"];
const DAY_MS = 24 * 3_600_000;

interface CommandResult {
  ok: boolean;
  output: string;
  missing: boolean;
}

function execute(argv: string[]): CommandResult {
  const [command, ...args] = argv;
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "pipe",
    env: process.env,
    // npm is a .cmd shim on Windows and needs a shell there.
    shell: process.platform === "win32" && command.endsWith(".cmd"),
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return {
    ok: result.status === 0,
    output,
    missing: result.error?.message.includes("ENOENT") ?? false,
  };
}

/** Prefer CLAUDE_BIN, then the newest Claude Code bundled with the desktop app, then PATH. */
function claudeBinary(): string {
  const bundledRoot =
    process.platform === "darwin" ? join(homedir(), "Library", "Application Support", "Claude", "claude-code") : undefined;
  let bundledVersions: string[] = [];
  if (bundledRoot) {
    try {
      bundledVersions = readdirSync(bundledRoot).filter((version) =>
        existsSync(join(bundledRoot, version, "claude.app", "Contents", "MacOS", "claude")),
      );
    } catch {
      // No desktop app installed.
    }
  }
  return resolveClaudeBinary({ configured: process.env.CLAUDE_BIN, bundledRoot, bundledVersions });
}

function nodeVersion(binary: string): string | null {
  const result = execute([binary, "--version"]);
  return result.ok ? result.output.trim() : null;
}

/**
 * Keep the Node.js binary the apps already launch the bridge with when it is
 * still valid, so an install from a different shell never swaps it silently.
 */
function chooseNode(parsed: ParsedCliCommand, claude: string): { binary: string; version: string; source: string } {
  const claudeCommand = execute([claude, "mcp", "get", MCP_NAME]).output.match(/Command:\s*(.+)/)?.[1]?.trim();
  const codexCommand = readCodexServerEntry(readIfExists(codexConfigPath()), MCP_NAME).command;
  const candidates: Array<[string | null | undefined, string]> = [
    [parsed.node, "--node"],
    [claudeCommand, "the current Claude registration"],
    [codexCommand, "the current Codex registration"],
    [process.execPath, "the Node.js running setup"],
  ];
  for (const [binary, source] of candidates) {
    if (!binary) continue;
    const version = nodeVersion(binary);
    if (version && supportedNode(version)) return { binary, version, source };
    if (source === "--node") throw new Error(`--node ${binary} is not a runnable Node.js 22.5 or newer (${version ?? "not runnable"})`);
  }
  throw new Error("No runnable Node.js 22.5 or newer was found");
}

function readIfExists(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function stamp(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

async function isClaudeSessionLive(sessionId: string): Promise<boolean> {
  if (process.platform !== "darwin") return true;
  return (await claudeSessions()).some((session) => session.sessionId === sessionId || session.bridgeSessionId === sessionId);
}

function newestMtime(directory: string): number {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs);
  }
  return newest;
}

/** In a development checkout, refuse to install a build older than its sources. */
function staleBuild(root: string): boolean {
  const source = join(root, "src");
  const server = join(root, "dist", "server.js");
  return existsSync(source) && existsSync(server) && newestMtime(source) > statSync(server).mtimeMs;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Start a candidate server with the chosen Node against a throwaway home and database, and list its tools. */
async function smokeTest(serverPath: string, nodeBinary: string): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), `${MCP_NAME}-smoke-`));
  const client = new Client({ name: "setup-smoke-test", version: VERSION });
  const transport = new StdioClientTransport({
    command: nodeBinary,
    args: [serverPath],
    env: {
      ...getDefaultEnvironment(),
      HOME: home,
      XDG_DATA_HOME: join(home, "data"),
      BRIDGE_DB_PATH: join(home, "smoke.sqlite"),
      BRIDGE_BACKUPS: "0",
    },
    stderr: "pipe",
  });
  try {
    await withTimeout(client.connect(transport), 20_000, "the server did not start within 20 seconds");
    const tools = (await withTimeout(client.listTools(), 10_000, "the server did not list its tools")).tools.map(
      (tool) => tool.name,
    );
    const missing = REQUIRED_TOOLS.filter((name) => !tools.includes(name));
    if (missing.length) throw new Error(`the server is missing tools: ${missing.join(", ")}`);
  } finally {
    await client.close().catch(() => {});
    rmSync(home, { recursive: true, force: true });
  }
}

function packageVersion(root: string): string {
  return (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
}

/** Install this package as a new runtime version, verified before it can be activated. */
async function installRuntime(nodeBinary: string): Promise<string> {
  const staging = mkdtempSync(join(tmpdir(), `${MCP_NAME}-pack-`));
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  try {
    const packed = execute([npm, "pack", packageRoot, "--ignore-scripts", "--pack-destination", staging]);
    if (!packed.ok) throw new Error(`Could not package the runtime: ${packed.output}`);
    const archive = readdirSync(staging).find((name) => name.endsWith(".tgz"));
    if (!archive) throw new Error("npm pack did not create a runtime archive");
    const id = versionId(packageVersion(packageRoot));
    const target = join(layout.versionsDir, id);
    ensurePrivateDirectory(layout.prefix);
    mkdirSync(target, { recursive: true });
    try {
      const installed = execute([
        npm,
        "install",
        "--prefix",
        target,
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        join(staging, archive),
      ]);
      if (!installed.ok) throw new Error(`Could not install the runtime: ${installed.output}`);
      const server = serverPathFor(packageRootIn(target));
      if (!existsSync(server)) throw new Error(`Installed runtime has no server: ${server}`);
      await smokeTest(server, nodeBinary);
    } catch (error) {
      rmSync(target, { recursive: true, force: true });
      throw new Error(`The new runtime was not activated: ${error instanceof Error ? error.message : String(error)}`);
    }
    return id;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

interface Registration {
  ok: boolean;
  changed: boolean;
  detail: string;
}

function registerClaude(nodeBinary: string, claude: string): Registration {
  const plan = buildRegistrationPlan({ packageRoot: stableRoot, nodeBinary, claudeBinary: claude });
  const current = execute(plan.claude.get);
  if (current.missing) return { ok: false, changed: false, detail: `Claude Code CLI not found (${claude}); set CLAUDE_BIN` };
  if (current.ok && current.output.includes(stableServer) && current.output.includes(nodeBinary)) {
    return { ok: true, changed: false, detail: "already uses the stable runtime" };
  }
  if (current.ok) {
    const removed = execute(plan.claude.remove);
    if (!removed.ok) return { ok: false, changed: false, detail: removed.output };
  }
  const added = execute(plan.claude.add);
  return { ok: added.ok, changed: added.ok, detail: added.ok ? "now uses the stable runtime" : added.output };
}

/** Keep the three newest config backups this tool wrote. */
function pruneConfigBackups(configPath: string, keep = 3): void {
  const prefix = `${basename(configPath)}.bak-${MCP_NAME}-`;
  const directory = dirname(configPath);
  const backups = readdirSync(directory).filter((name) => name.startsWith(prefix)).sort().reverse();
  for (const name of backups.slice(keep)) rmSync(join(directory, name), { force: true });
}

function writeConfig(path: string, previous: string, next: string): string | null {
  let backup: string | null = null;
  if (previous) {
    backup = `${path}.bak-${MCP_NAME}-${stamp()}`;
    writeFileSync(backup, previous, { mode: 0o600 });
  }
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, next, { mode });
  renameSync(temporary, path);
  pruneConfigBackups(path);
  return backup;
}

/**
 * Point Codex at the stable runtime by editing only this server's command,
 * args and tool timeout. `codex mcp add` would drop per-tool approval settings.
 */
function registerCodex(nodeBinary: string): Registration {
  const configPath = codexConfigPath();
  const original = readIfExists(configPath);
  let text = original;
  if (!readCodexServerEntry(text, MCP_NAME).found) {
    const plan = buildRegistrationPlan({ packageRoot: stableRoot, nodeBinary });
    const added = execute(plan.codex.add);
    if (!added.ok) {
      return { ok: false, changed: false, detail: added.missing ? "codex CLI not found on PATH; add the server manually" : added.output };
    }
    text = readIfExists(configPath);
  }
  const updated = updateCodexServerEntry(text, MCP_NAME, {
    command: nodeBinary,
    args: [stableServer],
    toolTimeoutSec: CODEX_TOOL_TIMEOUT_SEC,
  });
  if (!updated) return { ok: false, changed: false, detail: `No ${MCP_NAME} entry in ${configPath}` };
  if (updated.text === original) return { ok: true, changed: false, detail: "already uses the stable runtime" };
  const backup = writeConfig(configPath, original, updated.text);
  return { ok: true, changed: true, detail: `updated ${configPath}${backup ? ` (backup ${basename(backup)})` : ""}` };
}

function installEcosystem(sourceRoot: string, force: boolean): { installed: number; outdated: number } {
  let installed = 0;
  let outdated = 0;
  const copies: Array<{ from: string; to: string; directory: boolean }> = [];
  for (const target of resolveSkillTargets(homedir())) {
    for (const name of SKILLS) copies.push({ from: join(sourceRoot, "skills", name), to: join(target, name), directory: true });
  }
  copies.push({
    from: join(sourceRoot, "agents", "codex-teammate.md"),
    to: join(homedir(), ".claude", "agents", "codex-teammate.md"),
    directory: false,
  });
  for (const copy of copies) {
    if (!existsSync(copy.from)) continue;
    const marker = copy.directory ? "SKILL.md" : "";
    const existing = readIfExists(join(copy.to, marker));
    const incoming = readIfExists(join(copy.from, marker));
    if (existsSync(copy.to) && !force) {
      if (existing !== incoming) outdated += 1;
      continue;
    }
    mkdirSync(dirname(copy.to), { recursive: true });
    if (copy.directory) cpSync(copy.from, copy.to, { recursive: true, force: true });
    else copyFileSync(copy.from, copy.to);
    installed += 1;
  }
  return { installed, outdated };
}

function removeEcosystem(): void {
  for (const target of resolveSkillTargets(homedir())) {
    for (const name of SKILLS) rmSync(join(target, name), { recursive: true, force: true });
  }
  rmSync(join(homedir(), ".claude", "agents", "codex-teammate.md"), { force: true });
}

async function setup(parsed: ParsedCliCommand): Promise<number> {
  if (!existsSync(join(packageRoot, "dist", "server.js"))) {
    console.error(`Build output not found in ${packageRoot}. Run npm run build, or reinstall the package.`);
    return 1;
  }
  if (staleBuild(packageRoot) && !parsed.force) {
    console.error("dist/ is older than src/. Run npm run build first (or pass --force to install the existing build).");
    return 1;
  }
  console.log(`Claude Codex MCP Bridge ${VERSION} setup\n`);
  const claudeCli = claudeBinary();
  let node: { binary: string; version: string; source: string };
  let id: string;
  try {
    node = chooseNode(parsed, claudeCli);
    id = await installRuntime(node.binary);
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const previous = currentVersion(layout);
  activateVersion(layout, id);
  removeVersions(layout, versionsToPrune(listVersions(layout), id));
  const claude = registerClaude(node.binary, claudeCli);
  const codex = registerCodex(node.binary);
  const ecosystem = installEcosystem(stableRoot, parsed.force);

  console.log(`✓ Node.js ${node.version} (${node.binary}, from ${node.source})`);
  console.log(`✓ Runtime ${id} installed, smoke-tested and activated`);
  if (previous) console.log(`  Previous runtime ${previous} kept; undo with: claude-codex-mcp-bridge rollback`);
  console.log(`${claude.ok ? "✓" : "✗"} Claude registration: ${claude.detail}`);
  console.log(`${codex.ok ? "✓" : "✗"} Codex registration: ${codex.detail}`);
  const skills =
    ecosystem.installed === 0 && ecosystem.outdated === 0
      ? "already up to date"
      : `${ecosystem.installed} installed${ecosystem.outdated ? `, ${ecosystem.outdated} differ from this version (setup --force replaces them)` : ""}`;
  console.log(`✓ Skills and teammate: ${skills}`);
  console.log(`✓ Shared mailbox: ${dbPath}`);
  console.log("\nRunning sessions keep their current bridge. Open fresh Claude and Codex sessions to use this version.");
  if (!claude.ok || !codex.ok) {
    console.error("\nSetup was partial. Run `claude-codex-mcp-bridge doctor` for details.");
    return 1;
  }
  return 0;
}

type Level = "ok" | "warn" | "fail" | "info";
const SYMBOL: Record<Level, string> = { ok: "✓", warn: "!", fail: "✗", info: "·" };

async function doctor(parsed: ParsedCliCommand): Promise<number> {
  const results: Array<{ level: Level; name: string; detail: string }> = [];
  const add = (level: Level, name: string, detail: string) => results.push({ level, name, detail });

  const registeredNode = readCodexServerEntry(readIfExists(codexConfigPath()), MCP_NAME).command;
  if (registeredNode) {
    const version = nodeVersion(registeredNode);
    add(version && supportedNode(version) ? "ok" : "fail", "Node.js for the bridge", `${version ?? "not runnable"} (${registeredNode}; 22.5 or newer required)`);
  } else {
    add(supportedNode(process.version) ? "ok" : "fail", "Node.js", `${process.version} (22.5 or newer required)`);
  }

  const current = currentVersion(layout);
  if (current && existsSync(stableServer)) add("ok", "Stable runtime", `${current} (${listVersions(layout).length} installed)`);
  else add("warn", "Stable runtime", "not installed; run setup");

  const claudeCli = claudeBinary();
  const claudeVersion = execute([claudeCli, "--version"]);
  add(claudeVersion.ok ? "ok" : "warn", "Claude Code CLI", claudeVersion.ok ? `${claudeVersion.output} (${claudeCli})` : `${claudeCli} is not runnable; set CLAUDE_BIN`);
  const claude = execute([claudeCli, "mcp", "get", MCP_NAME]);
  if (claude.missing) add("warn", "Claude registration", "Claude Code CLI not found; set CLAUDE_BIN");
  else if (!claude.ok) add("fail", "Claude registration", "not registered; run setup");
  else if (claude.output.includes(stableServer)) add("ok", "Claude registration", "uses the stable runtime");
  else {
    const args = claude.output.match(/Args:\s*(.+)/)?.[1]?.trim() ?? "another path";
    add("warn", "Claude registration", `runs ${args}; rebuilding that checkout affects live sessions. Run setup to use the stable runtime.`);
  }

  const entry = readCodexServerEntry(readIfExists(codexConfigPath()), MCP_NAME);
  if (!entry.found) add("fail", "Codex registration", `not found in ${codexConfigPath()}; run setup`);
  else {
    const server = entry.args?.[0] ?? "unknown";
    add(server === stableServer ? "ok" : "warn", "Codex registration", server === stableServer ? "uses the stable runtime" : `runs ${server}; run setup to use the stable runtime`);
    const timeout = entry.toolTimeoutSec ?? 60;
    add(timeout >= 290 ? "ok" : "warn", "Codex tool timeout", timeout >= 290 ? `${timeout}s` : `${timeout}s cuts bridge_wait and Codex runs short; run setup`);
  }

  const codexBinary = resolveCodexBinary({ configuredBinary: process.env.CODEX_BIN });
  const codexVersion = execute([codexBinary, "--version"]);
  add(codexVersion.ok ? "ok" : "warn", "Codex CLI", codexVersion.ok ? `${codexVersion.output} (${codexBinary})` : `${codexBinary} is not runnable; set CODEX_BIN`);

  const report = inspectDatabase(dbPath);
  if (!report.exists) add("info", "Mailbox", `${dbPath} not created yet`);
  else if (report.error) add("fail", "Mailbox", report.error);
  else {
    add(report.quickCheck === "ok" ? "ok" : "fail", "Mailbox integrity", `${report.quickCheck}; ${report.messages} messages, schema v${report.schemaVersion}`);
    if ((report.schemaVersion ?? 0) < SCHEMA_VERSION) {
      add("info", "Mailbox schema", `v${report.schemaVersion}; the next bridge start backs it up and migrates it to v${SCHEMA_VERSION}`);
    }
    const loose = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, dirname(dbPath), runsDir()].filter((path) => {
      const mode = modeString(path);
      return mode !== null && (parseInt(mode, 8) & 0o077) !== 0 && (path !== dirname(dbPath) || basename(path) === basename(dataDir()));
    });
    if (process.platform === "win32") add("info", "Permissions", "not checked on Windows");
    else if (loose.length === 0) add("ok", "Permissions", "mailbox files are owner-only");
    else if (parsed.fix) {
      loose.forEach((path) => restrictToOwner(path));
      add("ok", "Permissions", `tightened ${loose.length} path(s) to owner-only`);
    } else add("warn", "Permissions", `${loose.length} mailbox path(s) are readable by other local users; run doctor --fix`);
    add(report.latestDailyBackup ? "ok" : "info", "Backups", report.latestDailyBackup ? `latest ${report.latestDailyBackup}` : "no daily backup yet; a running bridge takes one automatically");
    if (report.unreadDirect > 0) {
      const top = report.backlog.slice(0, 4).map((entry) => `${entry.agent} (${entry.unread})`).join(", ");
      add("warn", "Unhandled messages", `${report.unreadDirect} direct messages were never acknowledged. Most: ${top}. Review with \`prune\` to retire finished agents.`);
    } else add("ok", "Unhandled messages", "none");
    const claudePings = report.wakeLastWeek.filter((row) => row.app === "claude");
    const failed = claudePings.filter((row) => ["refused", "expired", "held"].includes(row.state)).reduce((sum, row) => sum + row.count, 0);
    const total = claudePings.reduce((sum, row) => sum + row.count, 0);
    if (failed > 0) {
      add("warn", "Claude background pings", `${failed} of ${total} in the last 7 days were held or expired. crossSessionInbound is ${crossSessionInbound() ?? "not set"}. ${CLAUDE_HOLD_EXPLANATION}`);
    } else if (total > 0) add("ok", "Claude background pings", `${total} in the last 7 days, none held or expired`);
    const codexPings = report.wakeLastWeek.filter((row) => row.app === "codex");
    if (codexPings.length) add("info", "Codex background pings", codexPings.map((row) => `${row.state} ${row.count}`).join(", "));
    const running = report.runs.running_codex ?? 0;
    if (running) add("info", "Codex runs", `${running} running; stale ones are recovered automatically by any bridge process`);
  }

  console.log(`Claude Codex MCP Bridge ${VERSION} doctor\n`);
  for (const result of results) console.log(`${SYMBOL[result.level]} ${result.name}: ${result.detail}`);
  return results.some((result) => result.level === "fail") ? 1 : 0;
}

function status(): number {
  console.log(`Claude Codex MCP Bridge ${VERSION} status\n`);
  console.log(`Runtime: ${currentVersion(layout) ?? "not installed (run setup)"}`);
  console.log(`Mailbox: ${dbPath}`);
  const report = inspectDatabase(dbPath);
  if (!report.exists) {
    console.log("State: not created yet");
    return 0;
  }
  if (report.error) {
    console.error(`Could not read the mailbox: ${report.error}`);
    return 1;
  }
  console.log(`Size: ${report.sizeBytes} bytes, schema v${report.schemaVersion}, permissions ${report.mode}`);
  console.log(`Messages: ${report.messages}; never acknowledged: ${report.unreadDirect}`);
  console.log(`Agents: ${report.agents} active${report.retiredAgents ? `, ${report.retiredAgents} retired` : ""}`);
  if (report.backlog.length) {
    console.log("\nLargest unhandled backlogs:");
    for (const entry of report.backlog) {
      const state = !entry.registered ? "never registered" : entry.retired ? "retired" : `last active ${entry.lastActivity ?? "unknown"}`;
      console.log(`- ${entry.agent}: ${entry.unread} (${state})`);
    }
  }
  const runs = Object.entries(report.runs).map(([state, total]) => `${state} ${total}`).join(", ");
  console.log(`\nCodex runs: ${runs || "none"}`);
  console.log(`Latest daily backup: ${report.latestDailyBackup ?? "none yet"}`);
  return 0;
}

function retire(parsed: ParsedCliCommand): number {
  const store = new BridgeStore(dbPath);
  try {
    const result = retireAgent(store, parsed.target as string, {
      by: "operator",
      note: parsed.note ?? undefined,
      closeBacklog: !parsed.keepBacklog,
    });
    console.log(`✓ Retired ${result.agent.name}${result.unbound ? " and removed its ping binding" : ""}`);
    console.log(`  Closed ${result.closed} unhandled message(s)${result.notified.length ? `; notified ${result.notified.join(", ")}` : ""}`);
    return 0;
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    store.close();
  }
}

async function prune(parsed: ParsedCliCommand): Promise<number> {
  const days = parsed.olderThanDays ?? 7;
  const store = new BridgeStore(dbPath);
  try {
    const stale = await findStaleAgents(store, { olderThanMs: days * DAY_MS, isClaudeSessionLive });
    if (stale.length === 0) {
      console.log(`No active agents have been idle for more than ${days} days.`);
      return 0;
    }
    console.log(`Agents idle for more than ${days} days:\n`);
    for (const agent of stale) {
      console.log(`- ${agent.name}: ${agent.unread} unread, last active ${agent.lastActivity}${agent.wake ? `, bound to ${agent.wake.app}` : ""}`);
    }
    const unread = stale.reduce((sum, agent) => sum + agent.unread, 0);
    if (!parsed.apply) {
      console.log(`\nDry run. Re-run with --apply to retire ${stale.length} agent(s)${parsed.keepBacklog ? "" : ` and close ${unread} unhandled message(s)`}. History is kept either way.`);
      return 0;
    }
    let notified = 0;
    for (const agent of stale) {
      const result = retireAgent(store, agent.name, {
        by: "operator",
        note: parsed.note ?? `idle for more than ${days} days`,
        closeBacklog: !parsed.keepBacklog,
      });
      notified += result.notified.length;
    }
    console.log(`\n✓ Retired ${stale.length} agent(s); ${notified} active sender notice(s) sent. Re-registering a name reactivates it.`);
    return 0;
  } finally {
    store.close();
  }
}

function backup(): number {
  const store = new BridgeStore(dbPath);
  try {
    const directory = store.backupDir as string;
    ensurePrivateDirectory(directory);
    const target = join(directory, `bridge-manual-${stamp()}.sqlite`);
    store.backupTo(target);
    console.log(`✓ Backup written to ${target}`);
    return 0;
  } finally {
    store.close();
  }
}

function rollback(): number {
  const current = currentVersion(layout);
  const previous = previousVersion(listVersions(layout), current);
  if (!previous) {
    console.error("No earlier runtime version is installed.");
    return 1;
  }
  activateVersion(layout, previous);
  console.log(`✓ Runtime switched from ${current ?? "none"} to ${previous}.`);
  console.log("New Claude and Codex sessions use it; running sessions keep their current code.");
  return 0;
}

async function demo(): Promise<number> {
  const threadId = `demo-${Date.now()}`;
  const sender = "demo-claude";
  const recipient = "demo-codex";
  const store = new BridgeStore(dbPath);
  try {
    store.register(sender, ["demo"]);
    store.register(recipient, ["demo"]);
    console.log("Claude Codex MCP Bridge live demo\n");
    console.log(`[1/4] ${recipient} is waiting on thread ${threadId}`);
    const waiting = waitForInbox(store, {
      agent: recipient,
      fromAgent: sender,
      threadId,
      timeoutMs: 3000,
      pollIntervalMs: 20,
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    console.log(`[2/4] ${sender} sends a review request`);
    store.send({
      fromAgent: sender,
      toAgent: recipient,
      threadId,
      body: "Review the proposed change and report the main risk.",
    });
    const result = await waiting;
    if (result.messages.length !== 1) throw new Error("Demo message was not delivered");
    const message = result.messages[0];
    console.log(`[3/4] ${recipient} woke automatically: ${message.body}`);
    store.ack(recipient, [message.id]);
    console.log("[4/4] Message acknowledged; durable thread history preserved");
    // Keep the live agent list clean; the thread history stays.
    for (const agent of [sender, recipient]) retireAgent(store, agent, { by: "demo", note: "demo finished", notifySenders: false });
    console.log("\n✓ Bridge demo passed");
    return 0;
  } catch (error) {
    console.error(`✗ Bridge demo failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    store.close();
  }
}

function uninstall(parsed: ParsedCliCommand): number {
  const plan = buildRegistrationPlan({ packageRoot: stableRoot, nodeBinary: process.execPath, claudeBinary: claudeBinary() });
  const claude = execute(plan.claude.remove);
  const codex = execute(plan.codex.remove);
  removeEcosystem();
  rmSync(layout.prefix, { recursive: true, force: true });
  if (parsed.purge) {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
    rmSync(dataDir(), { recursive: true, force: true });
  }
  console.log(`${claude.ok ? "✓" : "·"} Claude MCP registration removed`);
  console.log(`${codex.ok ? "✓" : "·"} Codex MCP registration removed`);
  console.log("✓ Installed bridge runtimes, skills and teammate definition removed");
  console.log(parsed.purge ? "✓ Local bridge data removed" : `Local data kept at ${dbPath}`);
  return 0;
}

function help(): number {
  console.log(`Claude Codex MCP Bridge ${VERSION}

Usage:
  claude-codex-mcp-bridge <command> [options]

Commands:
  setup [--force] [--node PATH]   Install a verified runtime, register Claude and Codex, install skills
  doctor [--fix]                  Check installation, mailbox health and ping delivery
  status                          Show mailbox size, backlog and runs
  demo                            Run a real local send/wait/ack smoke test
  retire <agent> [--note TEXT] [--keep-backlog]
                                  Retire a finished agent and close its unhandled messages
  prune [--older-than DAYS] [--apply] [--keep-backlog]
                                  List agents idle for DAYS (default 7); --apply retires them
  backup                          Write a point-in-time copy of the mailbox
  rollback                        Switch back to the previous installed runtime
  uninstall [--purge]             Remove registrations, runtimes and skills
  help                            Show this help

Options:
  --force         setup: replace installed skill copies, or install a stale build
  --node PATH     setup: Node.js binary the apps launch the bridge with (default: keep the current one)
  --fix           doctor: tighten mailbox file permissions
  --purge         uninstall: also remove local mailbox data
`);
  return 0;
}

async function main(): Promise<void> {
  try {
    const parsed = parseCliCommand(process.argv.slice(2));
    const handlers: Record<ParsedCliCommand["command"], () => number | Promise<number>> = {
      setup: () => setup(parsed),
      doctor: () => doctor(parsed),
      status,
      demo,
      retire: () => retire(parsed),
      prune: () => prune(parsed),
      backup,
      rollback,
      uninstall: () => uninstall(parsed),
      help,
    };
    process.exitCode = await handlers[parsed.command]();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

await main();
