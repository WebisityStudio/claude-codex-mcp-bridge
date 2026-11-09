import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { TurnFiles } from "./bridge-store.js";
import type { AppTurnOptions } from "./codex-app-turn.js";
import {
  DetachedTurnRunner,
  collectCodexTurn,
  parseExtraCodexConfig,
  pinnedCodexConfig,
  resolveCodexBinary,
  writeTurnSchema,
  type CodexTurnRequest,
  type DetachedCommand,
  type TurnOutcome,
} from "./orchestrator.js";

/**
 * How to start the turn driver. An installed bridge runs the compiled file;
 * a source checkout (tests, development) runs the TypeScript through tsx.
 */
export function appTurnDriver(): { command: string; args: string[] } {
  const compiled = fileURLToPath(new URL("./codex-app-turn.js", import.meta.url));
  if (existsSync(compiled)) return { command: process.execPath, args: [compiled] };
  const source = fileURLToPath(new URL("./codex-app-turn.ts", import.meta.url));
  // The worker's folder is the child's working directory, so name the loader by location.
  return { command: process.execPath, args: ["--import", import.meta.resolve("tsx"), source] };
}

/**
 * Codex worker turns through `codex app-server`. The chat is stored as an
 * interactive one, so the Codex app lists it and `codex://threads/<id>` opens
 * it. The turn itself still runs in a detached process outside the app.
 */
export class CodexAppServerRunner extends DetachedTurnRunner {
  readonly listedInApp = true;
  private readonly binary: string;
  private readonly schemaPath: string;
  private readonly extraConfig: string[];

  constructor(options: { binary?: string; dataDir?: string; timeoutMs?: number; extraConfig?: string[] } = {}) {
    super(options);
    this.binary = resolveCodexBinary({ configuredBinary: options.binary ?? process.env.CODEX_BIN });
    this.extraConfig = options.extraConfig ?? parseExtraCodexConfig(process.env.BRIDGE_CODEX_CONFIG);
    this.schemaPath = writeTurnSchema(this.dataDir);
  }

  /** What the driver is told for one turn. Exposed so tests can check the pins. */
  turnOptions(request: CodexTurnRequest, files: TurnFiles): AppTurnOptions {
    return {
      codex: this.binary,
      cwd: request.cwd,
      sandbox: request.sandbox,
      outputPath: files.outputPath,
      schemaPath: this.schemaPath,
      sessionId: request.sessionId,
      model: request.model ?? null,
      effort: request.effort ?? null,
      title: request.title ?? null,
      config: [
        ...this.extraConfig.flatMap((entry) => ["-c", entry]),
        ...pinnedCodexConfig({ sandbox: request.sandbox, model: request.model, effort: request.effort }),
      ],
    };
  }

  protected command(request: CodexTurnRequest, files: TurnFiles): DetachedCommand {
    const driver = appTurnDriver();
    return { command: driver.command, args: [...driver.args, JSON.stringify(this.turnOptions(request, files))] };
  }

  protected collect(files: TurnFiles, knownSessionId: string | null, exitCode: number | null): TurnOutcome {
    return collectCodexTurn(files, knownSessionId, exitCode);
  }
}
