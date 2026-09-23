import type { BridgeMessage } from "./bridge-store.js";

/** A message as returned by a paged read; long bodies may be shortened. */
export interface MessageView extends BridgeMessage {
  bodyTruncated?: true;
  bodyLength?: number;
}

export interface FitOptions {
  /** Total character budget for bodies plus envelopes. */
  maxChars?: number;
  /** Shorten every body to this many characters (preview mode). */
  maxBodyChars?: number;
}

/**
 * Default budget per tool result. Claude Code warns above ~10K tokens and cuts
 * MCP output at 25K tokens by default; 48K characters stays well inside that.
 */
export const DEFAULT_PAGE_CHARS = 48_000;
export const MAX_PAGE_CHARS = 400_000;
export const DEFAULT_PAGE_LIMIT = 25;
export const MAX_PAGE_LIMIT = 200;
const ENVELOPE_CHARS = 320;

function shorten(message: BridgeMessage, length: number): MessageView {
  return {
    ...message,
    body: message.body.slice(0, Math.max(0, length)),
    bodyTruncated: true,
    bodyLength: message.body.length,
  };
}

/**
 * Keep messages, in the given order, until the character budget is spent.
 * The first message always returns (shortened if it alone exceeds the budget)
 * so a reader can always make progress.
 */
export function fitMessages(
  messages: BridgeMessage[],
  options: FitOptions = {},
): { messages: MessageView[]; omitted: number } {
  const budget = Math.min(Math.max(options.maxChars ?? DEFAULT_PAGE_CHARS, 1_000), MAX_PAGE_CHARS);
  const views: MessageView[] = [];
  let used = 0;
  for (const message of messages) {
    let view: MessageView =
      options.maxBodyChars !== undefined && message.body.length > options.maxBodyChars
        ? shorten(message, options.maxBodyChars)
        : message;
    const size = view.body.length + ENVELOPE_CHARS;
    if (views.length > 0 && used + size > budget) break;
    if (size > budget) view = shorten(message, budget - ENVELOPE_CHARS);
    views.push(view);
    used += Math.min(size, budget);
  }
  return { messages: views, omitted: messages.length - views.length };
}

export function clampLimit(limit: number | undefined, fallback = DEFAULT_PAGE_LIMIT): number {
  return Math.min(Math.max(Math.trunc(limit ?? fallback), 1), MAX_PAGE_LIMIT);
}
