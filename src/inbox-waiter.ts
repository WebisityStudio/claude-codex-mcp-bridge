import { BridgeStore, type BridgeMessage } from "./bridge-store.js";

export interface WaitForInboxInput {
  agent: string;
  fromAgent?: string;
  threadId?: string;
  timeoutMs: number;
  pollIntervalMs?: number;
}

export interface WaitForInboxResult {
  timedOut: boolean;
  messages: BridgeMessage[];
}

function matchingMessages(store: BridgeStore, input: WaitForInboxInput): BridgeMessage[] {
  return store.inbox(input.agent).filter((message) => {
    if (input.fromAgent && message.fromAgent !== input.fromAgent) return false;
    if (input.threadId && message.threadId !== input.threadId) return false;
    return true;
  });
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
    const messages = matchingMessages(store, input);
    if (messages.length > 0) return { timedOut: false, messages };

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return { timedOut: true, messages: [] };
    await delay(Math.min(pollIntervalMs, remainingMs));
  }
}
