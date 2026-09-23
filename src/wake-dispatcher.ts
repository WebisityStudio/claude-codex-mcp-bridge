import type { BridgeStore } from "./bridge-store.js";
import { channelNotification, type ChannelNotification } from "./claude-channel.js";
import { ClaudeWake } from "./claude-wake.js";
import { wakeCodex } from "./codex-wake.js";
import type { WakeJob, WakeResult } from "./wake-queue.js";

/** Push path into the Claude session hosting this MCP process (opt-in). */
export interface ChannelDelivery {
  sessionId: string;
  send(notification: ChannelNotification): Promise<void>;
}

export interface DispatcherOptions {
  deliver?: (job: WakeJob) => Promise<WakeResult>;
  channel?: ChannelDelivery | null;
}

export class WakeDispatcher {
  private running: Promise<void> | null = null;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private claude: ClaudeWake;
  private deliver?: (job: WakeJob) => Promise<WakeResult>;
  private channel: ChannelDelivery | null;

  constructor(private store: BridgeStore, options: DispatcherOptions | ((job: WakeJob) => Promise<WakeResult>) = {}) {
    const resolved = typeof options === "function" ? { deliver: options } : options;
    this.deliver = resolved.deliver;
    this.channel = resolved.channel ?? null;
    this.claude = new ClaudeWake((job, result) => store.wakes.finish(job, result));
  }

  start(): void {
    this.heartbeat();
    this.timer = setInterval(() => {
      this.heartbeat();
      void this.flush().catch(() => {});
    }, 2000);
    this.timer.unref();
    void this.flush().catch(() => {});
  }

  private heartbeat(): void {
    if (this.channel && !this.stopped) {
      try { this.store.wakes.heartbeatChannel(this.channel.sessionId); } catch { /* retried next tick */ }
    }
  }

  flush(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.drain().finally(() => { this.running = null; });
    return this.running;
  }

  private async drain(): Promise<void> {
    if (!this.stopped) {
      const job = this.store.wakes.claim();
      if (!job) return;
      let result: WakeResult;
      try {
        result = await this.dispatch(job);
      } catch {
        result = { state: "unknown", detail: "Unexpected adapter failure; check the recipient before retrying" };
      }
      this.store.wakes.finish(job, result);
    }
  }

  private async dispatch(job: WakeJob): Promise<WakeResult> {
    if (this.deliver) return this.deliver(job);
    if (this.channel && job.target.app === "claude" && job.target.sessionId === this.channel.sessionId) {
      await this.channel.send(channelNotification(job));
      // Claude Code sends no receipt for channel events; an inbox read marks it read.
      return { state: "unknown", detail: "Pushed to this Claude Code session's channel; Claude Code returns no receipt. No automatic replay." };
    }
    return job.target.app === "codex" ? wakeCodex(job) : this.claude.wake(job);
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
    if (this.channel) {
      try { this.store.wakes.releaseChannel(this.channel.sessionId); } catch { /* store may be closing */ }
    }
    await this.claude.close();
  }
}
