import assert from "node:assert/strict";
import test from "node:test";

import { buildSafeEnvironment, resolveCodexBinary } from "../src/orchestrator.js";

test("safe environment preserves Windows process bootstrap variables without forwarding secrets", () => {
  const env = buildSafeEnvironment(
    {
      PATH: "C:\\tools",
      USERPROFILE: "C:\\Users\\agent",
      SystemRoot: "C:\\Windows",
      COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      TEMP: "C:\\Temp",
      TMP: "C:\\Temp",
      APPDATA: "C:\\Users\\agent\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\agent\\AppData\\Local",
      API_KEY: "must-not-leak",
    },
    "win32",
  );

  assert.equal(env.SystemRoot, "C:\\Windows");
  assert.equal(env.COMSPEC, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(env.PATHEXT, ".COM;.EXE;.BAT;.CMD");
  assert.equal(env.LOCALAPPDATA, "C:\\Users\\agent\\AppData\\Local");
  assert.equal(env.API_KEY, undefined);
});

test("safe environment preserves Unix bootstrap variables without forwarding secrets", () => {
  const env = buildSafeEnvironment(
    {
      PATH: "/usr/bin",
      HOME: "/home/agent",
      USER: "agent",
      SHELL: "/bin/bash",
      XDG_DATA_HOME: "/home/agent/.local/share",
      ANTHROPIC_API_KEY: "must-not-leak",
    },
    "linux",
  );

  assert.equal(env.HOME, "/home/agent");
  assert.equal(env.XDG_DATA_HOME, "/home/agent/.local/share");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test("Codex executable resolution prefers explicit configuration on every platform", () => {
  assert.equal(
    resolveCodexBinary({ platform: "win32", configuredBinary: "D:\\Codex\\codex.exe" }),
    "D:\\Codex\\codex.exe",
  );
});

test("Codex executable resolution uses the bundled macOS binary when installed", () => {
  assert.equal(
    resolveCodexBinary({ platform: "darwin", bundledMacExists: true }),
    "/Applications/ChatGPT.app/Contents/Resources/codex",
  );
});

test("Codex executable resolution falls back to PATH on Linux and Windows", () => {
  assert.equal(resolveCodexBinary({ platform: "linux" }), "codex");
  assert.equal(resolveCodexBinary({ platform: "win32" }), "codex");
});
