import { setTimeout as sleep } from "node:timers/promises";

import { BridgeStore, type BridgeMessage } from "./bridge-store.js";

export interface WaitForInboxInput {
  agent: string;
  fromAgent?: string;
  threadId?: string;
  timeoutMs: number;
  pollIntervalMs?: number;
  /** Upper bound on messages returned by one wake-up. */
  limit?: number;
  /** Aborted when the caller cancels or disconnects; the wait then ends empty-handed. */
  signal?: AbortSignal;
}

export interface WaitForInboxResult {
  timedOut: boolean;
  /** The caller went away first. No messages are returned, so none may be acknowledged for it. */
  aborted: boolean;
  messages: BridgeMessage[];
}

export async function waitForInbox(
  store: BridgeStore,
  input: WaitForInboxInput,
): Promise<WaitForInboxResult> {
  const pollIntervalMs = input.pollIntervalMs ?? 250;
  const deadline = Date.now() + input.timeoutMs;

  while (true) {
    if (input.signal?.aborted) return { timedOut: false, aborted: true, messages: [] };
    // Filters run in SQL so a large unread backlog is not re-read on every poll.
    const messages = store.inbox(input.agent, {
      fromAgent: input.fromAgent,
      threadId: input.threadId,
      limit: input.limit ?? 100,
    });
    if (messages.length > 0) return { timedOut: false, aborted: false, messages };

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return { timedOut: true, aborted: false, messages: [] };
    // Rejects on abort; the check at the top of the loop reports it.
    await sleep(Math.min(pollIntervalMs, remainingMs), undefined, { signal: input.signal }).catch(() => {});
  }
}
