import { BridgeStore, type BridgeMessage } from "./bridge-store.js";

export interface WaitForInboxInput {
  agent: string;
  fromAgent?: string;
  threadId?: string;
  timeoutMs: number;
  pollIntervalMs?: number;
  /** Upper bound on messages returned by one wake-up. */
  limit?: number;
}

export interface WaitForInboxResult {
  timedOut: boolean;
  messages: BridgeMessage[];
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitForInbox(
  store: BridgeStore,
  input: WaitForInboxInput,
): Promise<WaitForInboxResult> {
  const pollIntervalMs = input.pollIntervalMs ?? 250;
  const deadline = Date.now() + input.timeoutMs;

  while (true) {
    // Filters run in SQL so a large unread backlog is not re-read on every poll.
    const messages = store.inbox(input.agent, {
      fromAgent: input.fromAgent,
      threadId: input.threadId,
      limit: input.limit ?? 100,
    });
    if (messages.length > 0) return { timedOut: false, messages };

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return { timedOut: true, messages: [] };
    await delay(Math.min(pollIntervalMs, remainingMs));
  }
}
