import type { BridgeStore } from "./bridge-store.js";
import { ClaudeWake } from "./claude-wake.js";
import { wakeCodex } from "./codex-wake.js";
import type { WakeJob, WakeResult } from "./wake-queue.js";

export class WakeDispatcher {
  private running: Promise<void> | null = null;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private claude: ClaudeWake;

  constructor(private store: BridgeStore, private deliver?: (job: WakeJob) => Promise<WakeResult>) {
    this.claude = new ClaudeWake((job, result) => store.wakes.finish(job, result));
  }

  start(): void {
    this.timer = setInterval(() => { void this.flush().catch(() => {}); }, 2000);
    this.timer.unref();
    void this.flush().catch(() => {});
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
        result = await (this.deliver ? this.deliver(job)
          : job.target.app === "codex" ? wakeCodex(job) : this.claude.wake(job));
      } catch {
        result = { state: "unknown", detail: "Unexpected adapter failure; check the recipient before retrying" };
      }
      this.store.wakes.finish(job, result);
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
    await this.claude.close();
  }
}
