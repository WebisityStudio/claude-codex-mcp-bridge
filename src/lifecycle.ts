import type { AgentSummary, BridgeStore, RetireRecord } from "./bridge-store.js";
import { BRIDGE_AGENT } from "./notices.js";
import type { WakeTarget } from "./wake-queue.js";

/** Senders idle longer than this are not notified; they would only gather more backlog. */
const ACTIVE_SENDER_MS = 7 * 24 * 3_600_000;

export interface RetireOptions {
  by: string;
  note?: string;
  closeBacklog?: boolean;
  notifySenders?: boolean;
  now?: number;
}

export interface RetireResult extends RetireRecord {
  notified: string[];
}

function retirementNotice(name: string, record: RetireRecord, by: string, note: string | undefined, ids: number[]): string {
  const list = ids.slice(0, 20).map((id) => `#${id}`).join(", ") + (ids.length > 20 ? `, and ${ids.length - 20} more` : "");
  return [
    `"${name}" was retired by ${by}${note ? ` (${note})` : ""}.`,
    `${ids.length} of your messages to it were closed without being handled: ${list}.`,
    "If that work still matters, send it to an active agent. The original messages remain in the thread history.",
    "This is an automated bridge notice. Do not reply to it.",
  ].join("\n\n");
}

/**
 * Retire a finished agent: stop its pings, close its unhandled backlog with a
 * recorded reason, and tell recently active senders what was closed.
 */
export function retireAgent(store: BridgeStore, name: string, options: RetireOptions): RetireResult {
  const now = options.now ?? Date.now();
  const record = store.retire(name, {
    by: options.by,
    note: options.note,
    closeBacklog: options.closeBacklog ?? true,
  });
  const notified: string[] = [];
  if (options.notifySenders ?? true) {
    for (const sender of record.bySender) {
      if ([options.by, name, BRIDGE_AGENT].includes(sender.fromAgent)) continue;
      const agent = store.getAgent(sender.fromAgent);
      const last = store.lastActivity(sender.fromAgent);
      if (!agent || agent.retiredAt || !last || now - Date.parse(last) > ACTIVE_SENDER_MS) continue;
      store.send({
        fromAgent: BRIDGE_AGENT,
        toAgent: sender.fromAgent,
        body: retirementNotice(name, record, options.by, options.note, sender.messageIds),
        idempotencyKey: `retired:${name}:${record.agent.retiredAt}:${sender.fromAgent}`,
      });
      notified.push(sender.fromAgent);
    }
  }
  return { ...record, notified };
}

export interface StaleAgent extends AgentSummary {
  wake: WakeTarget | null;
}

/**
 * Active agents with no observable activity for `olderThanMs`. Agents bound
 * to a Claude session that is still running are never stale.
 */
export async function findStaleAgents(
  store: BridgeStore,
  options: {
    olderThanMs: number;
    now?: number;
    isClaudeSessionLive?: (sessionId: string) => Promise<boolean>;
  },
): Promise<StaleAgent[]> {
  const now = options.now ?? Date.now();
  const stale: StaleAgent[] = [];
  for (const summary of store.agentSummaries()) {
    if (now - Date.parse(summary.lastActivity) <= options.olderThanMs) continue;
    const wake = store.wakes.target(summary.name);
    if (wake?.app === "claude" && options.isClaudeSessionLive && (await options.isClaudeSessionLive(wake.sessionId))) {
      continue;
    }
    stale.push({ ...summary, wake });
  }
  return stale;
}
