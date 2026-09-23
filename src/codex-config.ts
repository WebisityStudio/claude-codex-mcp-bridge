import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Minimal, targeted edits to one `[mcp_servers.<name>]` table in Codex's
 * config.toml. `codex mcp add` replaces the whole table and drops nested
 * per-tool settings such as approval modes, so setup edits only the
 * `command`, `args` and missing `tool_timeout_sec` lines in place.
 */

export function codexConfigPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const codexHome = env.CODEX_HOME?.trim() || join(home, ".codex");
  return join(codexHome, "config.toml");
}

export interface CodexServerEntry {
  found: boolean;
  command: string | null;
  args: string[] | null;
  toolTimeoutSec: number | null;
}

export interface CodexServerUpdate {
  command: string;
  args: string[];
  /** Added only when the table has no tool_timeout_sec of its own. */
  toolTimeoutSec?: number;
}

interface Section {
  start: number;
  end: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findSection(lines: string[], name: string): Section | null {
  const quoted = escapeRegExp(name);
  const header = new RegExp(
    `^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:"${quoted}"|'${quoted}'|${quoted})\\s*\\]\\s*(?:#.*)?$`,
  );
  const start = lines.findIndex((line) => header.test(line.replace(/\r$/, "")));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end += 1;
  return { start, end };
}

/** Count brackets outside TOML strings to find where a (possibly multi-line) array ends. */
function bracketDepth(text: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === "\\" && quote === '"') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "#") break;
    if (char === '"' || char === "'") quote = char;
    else if (char === "[") depth += 1;
    else if (char === "]") depth -= 1;
  }
  return depth;
}

/** Lines [start, end) occupied by `key = ...` inside the section, if present. */
function findKey(lines: string[], section: Section, key: string): { start: number; end: number } | null {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  for (let index = section.start + 1; index < section.end; index += 1) {
    if (!pattern.test(lines[index])) continue;
    let end = index + 1;
    let depth = bracketDepth(lines[index].slice(lines[index].indexOf("=") + 1));
    while (depth > 0 && end < section.end) {
      depth += bracketDepth(lines[end]);
      end += 1;
    }
    return { start: index, end };
  }
  return null;
}

function parseStrings(text: string): string[] {
  const values: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
  for (const match of text.matchAll(pattern)) {
    if (match[1] !== undefined) {
      try {
        values.push(JSON.parse(`"${match[1]}"`) as string);
      } catch {
        values.push(match[1]);
      }
    } else {
      values.push(match[2]);
    }
  }
  return values;
}

function valueText(lines: string[], range: { start: number; end: number }): string {
  const joined = lines.slice(range.start, range.end).join("\n");
  return joined.slice(joined.indexOf("=") + 1);
}

export function readCodexServerEntry(text: string, name: string): CodexServerEntry {
  const lines = text.split("\n");
  const section = findSection(lines, name);
  if (!section) return { found: false, command: null, args: null, toolTimeoutSec: null };
  const command = findKey(lines, section, "command");
  const args = findKey(lines, section, "args");
  const timeout = findKey(lines, section, "tool_timeout_sec");
  const timeoutValue = timeout ? Number(valueText(lines, timeout).replace(/#.*/, "").trim()) : NaN;
  return {
    found: true,
    command: command ? parseStrings(valueText(lines, command))[0] ?? null : null,
    args: args ? parseStrings(valueText(lines, args)) : null,
    toolTimeoutSec: Number.isFinite(timeoutValue) ? timeoutValue : null,
  };
}

/** TOML basic strings accept JSON string escapes. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Point an existing server table at a new command, keeping every other line
 * (nested tool tables, env, enabled flags, comments) untouched. Returns null
 * when the table does not exist.
 */
export function updateCodexServerEntry(
  text: string,
  name: string,
  update: CodexServerUpdate,
): { text: string; changed: boolean } | null {
  const lines = text.split("\n");
  const section = findSection(lines, name);
  if (!section) return null;

  const replacements: Array<{ range: { start: number; end: number } | null; line: string; after: number }> = [];
  const commandRange = findKey(lines, section, "command");
  const argsRange = findKey(lines, section, "args");
  replacements.push({ range: commandRange, line: `command = ${tomlString(update.command)}`, after: section.start });
  replacements.push({
    range: argsRange,
    line: `args = [${update.args.map(tomlString).join(", ")}]`,
    after: commandRange ? commandRange.end - 1 : section.start,
  });

  const output = [...lines];
  // Apply from the bottom up so earlier indices stay valid.
  const timeoutRange = findKey(lines, section, "tool_timeout_sec");
  const edits: Array<{ start: number; deleteCount: number; lines: string[] }> = [];
  for (const item of replacements) {
    if (item.range) edits.push({ start: item.range.start, deleteCount: item.range.end - item.range.start, lines: [item.line] });
    else edits.push({ start: item.after + 1, deleteCount: 0, lines: [item.line] });
  }
  if (!timeoutRange && update.toolTimeoutSec !== undefined) {
    const anchor = argsRange ? argsRange.end : commandRange ? commandRange.end : section.start + 1;
    edits.push({ start: anchor, deleteCount: 0, lines: [`tool_timeout_sec = ${update.toolTimeoutSec}`] });
  }
  edits.sort((a, b) => b.start - a.start || b.deleteCount - a.deleteCount);
  for (const edit of edits) output.splice(edit.start, edit.deleteCount, ...edit.lines);
  const result = output.join("\n");
  return { text: result, changed: result !== text };
}
