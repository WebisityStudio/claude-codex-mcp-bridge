import { wakeNotice, type WakeJob } from "./wake-queue.js";

/**
 * Claude Code channels (research preview): an MCP server that declares this
 * experimental capability can push events into the session that launched it.
 * Claude Code only listens when started with `--channels server:<name>` or
 * `--dangerously-load-development-channels server:<name>`; otherwise the
 * events are dropped. The desktop app does not expose either option, so this
 * adapter is opt-in with BRIDGE_CLAUDE_CHANNEL=1.
 */
export const CHANNEL_CAPABILITY = "claude/channel";
export const CHANNEL_METHOD = "notifications/claude/channel";

export interface ChannelNotification {
  method: typeof CHANNEL_METHOD;
  params: { content: string; meta: Record<string, string> };
}

/** The Claude session this process can push into, when channel mode is enabled. */
export function channelSession(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.BRIDGE_CLAUDE_CHANNEL !== "1") return null;
  return env.CLAUDE_CODE_SESSION_ID?.trim() || null;
}

/** Meta keys must be identifiers; Claude Code drops anything else. */
export function channelNotification(job: WakeJob): ChannelNotification {
  const meta: Record<string, string> = { message_id: String(job.messageId), recipient: job.agent };
  if (job.fromAgent) meta.from_agent = job.fromAgent;
  if (job.threadId) meta.thread_id = job.threadId;
  return { method: CHANNEL_METHOD, params: { content: wakeNotice(job), meta } };
}
