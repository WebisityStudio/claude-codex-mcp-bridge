import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("the published package includes its installation lock", () => {
  const cwd = dirname(dirname(fileURLToPath(import.meta.url)));
  const npm = process.env.npm_execpath;
  assert.ok(npm, "run the packaging regression through npm test");
  const result = JSON.parse(execFileSync(process.execPath, [npm, "pack", "--ignore-scripts", "--dry-run", "--json"], {
    cwd, encoding: "utf8", timeout: 20_000,
  }));
  const files: string[] = result[0].files.map((file: { path: string }) => file.path);
  assert.ok(files.includes("npm-shrinkwrap.json"), "the installed runtime must use the reviewed dependency tree");
  assert.ok(files.includes("dist/server.js"));
  assert.ok(!files.some((path) => path.startsWith("node_modules/") || path.endsWith(".sqlite") || path.startsWith(".env")));
});
