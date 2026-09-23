import type { BridgeStore } from "./bridge-store.js";
import type { WakeJob } from "./wake-queue.js";

/**
 * Reserved sender for automated notices: delivery failures, retirements and
 * Codex run results. It never registers, and its own messages never trigger
 * further notices, so notices cannot loop.
 */
export const BRIDGE_AGENT = "bridge";

/** At most one delivery-failure notice per sender/recipient pair per window. */
const NOTICE_WINDOW_MS = 30 * 60_000;

export const CLAUDE_HOLD_EXPLANATION =
  "Claude Code holds cross-session messages when the recipient session runs in Bypass permissions " +
  "and the sender does not state a permission mode (Claude Code's crossSessionInbound setting). " +
  "The desktop app shows no approval prompt for them, so they expire unread. The user can switch " +
  "that session out of Bypass permissions, approve held messages in a terminal session, or " +
  'deliberately set "crossSessionInbound": "accept" in ~/.claude/settings.json. The bridge never ' +
  "changes that setting.";

function isClaudeHold(job: WakeJob): boolean {
  return job.target.app === "claude" && (job.state === "held" || /\b(expired|held)\b/i.test(job.detail));
}

export function explainFailure(job: WakeJob): string {
  if (isClaudeHold(job)) return CLAUDE_HOLD_EXPLANATION;
  if (job.state === "expired") {
    return job.pendingReason === "busy"
      ? "The recipient stayed busy for the whole 24-hour retry window."
      : "The recipient's app session was unreachable for the whole one-hour retry window.";
  }
  return `The recipient app reported: ${job.detail}`;
}

export function deliveryFailureNotice(job: WakeJob): string {
  const target = `${JSON.stringify(job.agent)}${job.threadId ? ` (thread ${JSON.stringify(job.threadId)})` : ""}`;
  const outcome =
    job.state === "held"
      ? "is being held for approval in the recipient's Claude session"
      : `ended "${job.state}"`;
  return [
    `Delivery problem: your message #${job.messageId} to ${target} was saved, but its background ping ${outcome}.`,
    `Why: ${explainFailure(job)}`,
    `The message is still unread in ${JSON.stringify(job.agent)}'s inbox. Options: send the work to another agent, ask the user to open that conversation, or check bridge_outbox for everything still unhandled.`,
    "This is an automated bridge notice. Do not reply to it.",
  ].join("\n\n");
}

/**
 * Tell senders when a background ping fails, so work does not silently stall.
 * Each failed ping is claimed atomically, so several bridge processes can run
 * this concurrently. Returns how many failures were processed.
 */
export function sweepDeliveryFailures(store: BridgeStore, now = Date.now(), max = 20): number {
  let processed = 0;
  for (; processed < max; processed += 1) {
    const job = store.wakes.claimFailure(now);
    if (!job) break;
    const sender = job.fromAgent;
    if (!sender || sender === BRIDGE_AGENT || sender === job.agent) continue;
    const agent = store.getAgent(sender);
    if (!agent || agent.retiredAt) continue;
    store.send({
      fromAgent: BRIDGE_AGENT,
      toAgent: sender,
      threadId: job.threadId ?? null,
      body: deliveryFailureNotice(job),
      idempotencyKey: `delivery:${sender}->${job.agent}:${Math.floor(now / NOTICE_WINDOW_MS)}`,
    });
  }
  return processed;
}
