#!/usr/bin/env node

import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { BridgeStore } from "./bridge-store.js";
import { waitForInbox } from "./inbox-waiter.js";
import {
  MCP_NAME,
  PACKAGE_NAME,
  buildRegistrationPlan,
  parseCliCommand,
  resolveRuntimePrefix,
  resolveSkillTargets,
  type CommandPlan,
} from "./cli-logic.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimePrefix = resolveRuntimePrefix(homedir());
const stablePackageRoot = join(runtimePrefix, "node_modules", PACKAGE_NAME);
const defaultDbPath =
  process.env.BRIDGE_DB_PATH ?? join(homedir(), ".local", "share", MCP_NAME, "bridge.sqlite");

interface CommandResult {
  ok: boolean;
  output: string;
  missing: boolean;
}

function execute(argv: string[], quiet = false): CommandResult {
  const [command, ...args] = argv;
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: quiet ? "pipe" : ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return {
    ok: result.status === 0,
    output,
    missing: result.error?.message.includes("ENOENT") ?? false,
  };
}

function replaceRegistration(plan: CommandPlan): CommandResult {
  const current = execute(plan.get, true);
  if (current.ok) execute(plan.remove, true);
  return execute(plan.add, true);
}

function installStableRuntime(): string {
  if (packageRoot === stablePackageRoot && existsSync(join(stablePackageRoot, "dist", "server.js"))) {
    return stablePackageRoot;
  }

  const staging = mkdtempSync(join(tmpdir(), `${MCP_NAME}-pack-`));
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  try {
    const packed = execute(
      [npm, "pack", packageRoot, "--ignore-scripts", "--pack-destination", staging],
      true,
    );
    if (!packed.ok) throw new Error(`Could not package the runtime: ${packed.output}`);
    const archive = readdirSync(staging).find((name) => name.endsWith(".tgz"));
    if (!archive) throw new Error("npm pack did not create a runtime archive");
    mkdirSync(runtimePrefix, { recursive: true });
    const installed = execute(
      [
        npm,
        "install",
        "--prefix",
        runtimePrefix,
        "--omit=dev",
        "--ignore-scripts",
        join(staging, archive),
      ],
      true,
    );
    if (!installed.ok) throw new Error(`Could not install the stable runtime: ${installed.output}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  const serverPath = join(stablePackageRoot, "dist", "server.js");
  if (!existsSync(serverPath)) throw new Error(`Stable MCP server not found after install: ${serverPath}`);
  return stablePackageRoot;
}

function installDirectory(source: string, destination: string, force: boolean): number {
  if (!existsSync(source)) return 0;
  mkdirSync(destination, { recursive: true });
  let installed = 0;
  for (const name of ["ask-codex", "review-with-codex", "claude-codex-coordinator"]) {
    const from = join(source, name);
    const to = join(destination, name);
    if (!existsSync(from)) continue;
    if (existsSync(to) && !force) continue;
    cpSync(from, to, { recursive: true, force: true });
    installed += 1;
  }
  return installed;
}

function installEcosystem(sourceRoot: string, force: boolean): { skills: number; agents: number } {
  let skills = 0;
  for (const target of resolveSkillTargets(homedir())) {
    skills += installDirectory(join(sourceRoot, "skills"), target, force);
  }

  const sourceAgent = join(sourceRoot, "agents", "codex-teammate.md");
  const targetDir = join(homedir(), ".claude", "agents");
  const targetAgent = join(targetDir, "codex-teammate.md");
  let agents = 0;
  if (existsSync(sourceAgent) && (force || !existsSync(targetAgent))) {
    mkdirSync(targetDir, { recursive: true });
    copyFileSync(sourceAgent, targetAgent);
    agents = 1;
  }
  return { skills, agents };
}

function removeEcosystem(): void {
  for (const target of resolveSkillTargets(homedir())) {
    for (const name of ["ask-codex", "review-with-codex", "claude-codex-coordinator"]) {
      rmSync(join(target, name), { recursive: true, force: true });
    }
  }
  rmSync(join(homedir(), ".claude", "agents", "codex-teammate.md"), { force: true });
}

function setup(force: boolean): number {
  const sourceServer = join(packageRoot, "dist", "server.js");
  if (!existsSync(sourceServer)) {
    console.error(`Build output not found: ${sourceServer}`);
    console.error("Run npm run build, or reinstall the package.");
    return 1;
  }

  console.log("Claude Codex MCP Bridge setup\n");
  let installedRoot: string;
  try {
    installedRoot = installStableRuntime();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const plan = buildRegistrationPlan({ packageRoot: installedRoot, nodeBinary: process.execPath });
  const claude = replaceRegistration(plan.claude);
  const codex = replaceRegistration(plan.codex);
  const ecosystem = installEcosystem(installedRoot, force);

  console.log(`✓ Stable runtime: ${installedRoot}`);
  console.log(`${claude.ok ? "✓" : "✗"} Claude MCP registration${claude.output ? `: ${claude.output}` : ""}`);
  console.log(`${codex.ok ? "✓" : "✗"} Codex MCP registration${codex.output ? `: ${codex.output}` : ""}`);
  console.log(`✓ Installed ${ecosystem.skills} skill copies and ${ecosystem.agents} teammate definition(s)`);
  console.log(`✓ Shared database: ${defaultDbPath}`);
  console.log("\nOpen fresh Claude and Codex sessions, then run: claude-codex-mcp-bridge demo");

  if (!claude.ok || !codex.ok) {
    console.error("\nSetup was partial. Run `claude-codex-mcp-bridge doctor` for details.");
    return 1;
  }
  return 0;
}

function doctor(): number {
  const plan = buildRegistrationPlan({ packageRoot: stablePackageRoot, nodeBinary: process.execPath });
  const checks = [
    { name: "Node >=22.5", result: { ok: Number(process.versions.node.split(".")[0]) >= 22, output: process.version, missing: false } },
    { name: "Built MCP server", result: { ok: existsSync(plan.serverPath), output: plan.serverPath, missing: false } },
    { name: "Claude registration", result: execute(plan.claude.get, true) },
    { name: "Codex registration", result: execute(plan.codex.get, true) },
  ];
  console.log("Claude Codex MCP Bridge doctor\n");
  for (const check of checks) {
    const detail = check.result.missing ? "command not found" : check.result.output;
    console.log(`${check.result.ok ? "✓" : "✗"} ${check.name}${detail ? `: ${detail}` : ""}`);
  }
  console.log(`${existsSync(defaultDbPath) ? "✓" : "·"} Database: ${defaultDbPath}`);
  return checks.every((check) => check.result.ok) ? 0 : 1;
}

function status(): number {
  console.log("Claude Codex MCP Bridge status\n");
  console.log(`Database: ${defaultDbPath}`);
  if (!existsSync(defaultDbPath)) {
    console.log("State: not created yet");
    return 0;
  }
  const store = new BridgeStore(defaultDbPath);
  try {
    const agents = store.agents();
    console.log(`Size: ${statSync(defaultDbPath).size} bytes`);
    console.log(`Registered agents: ${agents.length}`);
    for (const agent of agents) {
      console.log(`- ${agent.name} (last seen ${agent.lastSeen})`);
    }
  } finally {
    store.close();
  }
  return 0;
}

async function demo(): Promise<number> {
  const threadId = `demo-${Date.now()}`;
  const sender = "demo-claude";
  const recipient = "demo-codex";
  const store = new BridgeStore(defaultDbPath);
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
    console.log("\n✓ Bridge demo passed");
    return 0;
  } catch (error) {
    console.error(`✗ Bridge demo failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    store.close();
  }
}

function uninstall(purge: boolean): number {
  const plan = buildRegistrationPlan({ packageRoot: stablePackageRoot, nodeBinary: process.execPath });
  const claude = execute(plan.claude.remove, true);
  const codex = execute(plan.codex.remove, true);
  removeEcosystem();
  rmSync(runtimePrefix, { recursive: true, force: true });
  if (purge) rmSync(dirname(defaultDbPath), { recursive: true, force: true });
  console.log(`${claude.ok ? "✓" : "·"} Claude MCP registration removed`);
  console.log(`${codex.ok ? "✓" : "·"} Codex MCP registration removed`);
  console.log("✓ Installed bridge runtime, skills and teammate definition removed");
  console.log(purge ? "✓ Local bridge data removed" : `Local data kept at ${defaultDbPath}`);
  return 0;
}

function help(): number {
  console.log(`Claude Codex MCP Bridge

Usage:
  claude-codex-mcp-bridge <command> [options]

Commands:
  setup [--force]     Register both clients and install skills
  doctor              Check dependencies and registrations
  status              Show local bridge state and registered agents
  demo                Run a real local send/wait/ack smoke test
  uninstall [--purge] Remove registrations and installed integrations
  help                 Show this help

Options:
  --force  Replace existing bridge skill copies
  --purge  Also remove local SQLite data during uninstall
`);
  return 0;
}

async function main(): Promise<void> {
  try {
    const parsed = parseCliCommand(process.argv.slice(2));
    const code =
      parsed.command === "setup"
        ? setup(parsed.force)
        : parsed.command === "doctor"
          ? doctor()
          : parsed.command === "status"
            ? status()
            : parsed.command === "demo"
              ? await demo()
              : parsed.command === "uninstall"
                ? uninstall(parsed.purge)
                : help();
    process.exitCode = code;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

await main();
