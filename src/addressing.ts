import type { BridgeStore } from "./bridge-store.js";
import { BRIDGE_AGENT, CLAUDE_HOLD_EXPLANATION } from "./notices.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STALE_UNBOUND_MS = 24 * 3_600_000;

export const RESERVED_AGENT_NAMES = new Set(["*", BRIDGE_AGENT]);

/** Why a name cannot be registered, or null when it is fine. */
export function agentNameProblem(name: string): string | null {
  if (name.trim() !== name || name === "") return "Agent names cannot be empty or start or end with spaces.";
  if (RESERVED_AGENT_NAMES.has(name)) return `"${name}" is reserved by the bridge.`;
  if (UUID_PATTERN.test(name)) {
    return "That looks like a session ID, not an agent name. Choose a readable name such as review-claude and pass the session in wake instead.";
  }
  if (name.length > 128) return "Agent names are limited to 128 characters.";
  return null;
}

export function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[b.length];
}

/** Registered names that look like what the caller meant. */
export function suggestNames(target: string, names: string[], max = 3): string[] {
  const wanted = target.toLowerCase();
  const threshold = Math.max(2, Math.floor(target.length / 4));
  return names
    .map((name) => {
      const candidate = name.toLowerCase();
      const related = candidate.includes(wanted) || wanted.includes(candidate);
      return { name, score: related ? 1 : editDistance(wanted, candidate) };
    })
    .filter((entry) => entry.score <= threshold && entry.name !== target)
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, max)
    .map((entry) => entry.name);
}

export interface RecipientCheck {
  ok: boolean;
  error?: string;
  warnings: string[];
  suggestions: string[];
}

export interface RecipientCheckOptions {
  allowUnregistered?: boolean;
  isClaudeSessionLive?: (sessionId: string) => Promise<boolean>;
  now?: number;
}

function ago(iso: string, now: number): string {
  const hours = Math.round((now - Date.parse(iso)) / 3_600_000);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)} days ago`;
}

/**
 * Decide whether a direct message can be addressed to `to`, and what the
 * sender should know about how (or whether) it will be picked up.
 */
export async function checkRecipient(
  store: BridgeStore,
  to: string,
  options: RecipientCheckOptions = {},
): Promise<RecipientCheck> {
  if (to === "*") return { ok: true, warnings: [], suggestions: [] };
  const now = options.now ?? Date.now();
  const warnings: string[] = [];
  const agent = store.getAgent(to);
  if (!agent) {
    const suggestions = suggestNames(to, store.agents().map((entry) => entry.name));
    const hint = UUID_PATTERN.test(to) ? " That looks like a session ID; send to the agent name bound to that session." : "";
    const detail = `No agent named "${to}" is registered.${hint}${suggestions.length ? ` Did you mean: ${suggestions.join(", ")}?` : ""}`;
    if (!options.allowUnregistered) {
      return { ok: false, error: `${detail} If it will register later, resend with allowUnregistered: true.`, warnings, suggestions };
    }
    return { ok: true, warnings: [detail], suggestions };
  }
  if (agent.retiredAt) {
    const detail = `"${to}" was retired at ${agent.retiredAt} by ${agent.retiredBy}${agent.retireNote ? ` (${agent.retireNote})` : ""}.`;
    if (!options.allowUnregistered) {
      return { ok: false, error: `${detail} Send to an active agent, or resend with allowUnregistered: true.`, warnings, suggestions: [] };
    }
    warnings.push(detail);
  }

  const recent = store.wakes.health(to, 3);
  if (recent.length === 3 && recent.every((job) => ["refused", "expired", "held"].includes(job.state))) {
    const hold = recent[0].app === "claude" ? ` ${CLAUDE_HOLD_EXPLANATION}` : "";
    warnings.push(
      `The last 3 background pings to "${to}" were not delivered (latest: ${recent[0].state}: ${recent[0].detail}). Expect no automatic pickup.${hold}`,
    );
  }
  const target = store.wakes.target(to);
  if (target?.app === "claude" && options.isClaudeSessionLive && !(await options.isClaudeSessionLive(target.sessionId))) {
    warnings.push(`"${to}"'s Claude session is not running. The message will wait in its inbox until that conversation reads it.`);
  }
  if (!target) {
    const last = store.lastActivity(to);
    if (last && now - Date.parse(last) > STALE_UNBOUND_MS) {
      warnings.push(`"${to}" has no background ping binding and was last active ${ago(last, now)}. Nothing will prompt it to read this.`);
    }
  }
  return { ok: true, warnings, suggestions: [] };
}
