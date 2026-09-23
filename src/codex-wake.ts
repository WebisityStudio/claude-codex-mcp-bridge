import { homedir } from "node:os";
import { join } from "node:path";
import { CodexIpc } from "./local-ipc.js";
import { wakeNotice, type WakeJob, type WakeResult } from "./wake-queue.js";

export function codexTurn(job: WakeJob) {
  const text = wakeNotice(job);
  const callId = "bridge_" + job.attemptId;
  // Peer content is a tool result, never a system/developer/user instruction.
  return {
    conversationId: job.target.sessionId,
    turnStart: {
      request: { threadId: job.target.sessionId, input: [] },
      context: {
        responseItems: [
          { type: "function_call", call_id: callId, name: "untrusted_input", arguments: "{}" },
          { type: "function_call_output", call_id: callId,
            output: [{ type: "input_text", text }] },
        ],
      },
    },
  };
}

export async function wakeCodex(job: WakeJob,
  path = join(homedir(), ".codex", "ipc", "ipc.sock")): Promise<WakeResult> {
  if (process.platform === "win32") return { state: "refused", detail: "Native desktop wake adapter requires Unix local sockets" };
  const ipc = new CodexIpc();
  let submitted = false;
  try {
    await ipc.connect(path);
    const owner = await ipc.request("thread-owner-discovery",
      { hostId: "local", conversationId: job.target.sessionId }, 1);
    if (owner.resultType !== "success" || !owner.handledByClientId) {
      return { state: "pending", detail: "Codex task has no connected owner", reason: "offline" };
    }
    if (owner.result?.supportsUntrustedAppInput !== true) {
      return { state: "refused", detail: "Codex owner does not support peer content; update the app" };
    }
    submitted = true;
    const reply = await ipc.request("thread-follower-start-turn", codexTurn(job), 2, owner.handledByClientId);
    if (reply.resultType === "success") {
      if (typeof reply.result?.result?.turn?.id !== "string") {
        return { state: "unknown", detail: "Codex returned an unfamiliar receipt; check the task before retrying" };
      }
      return { state: "accepted", detail: "Codex confirmed a new turn" };
    }
    // This exact native guard runs before context injection or turn creation.
    if (reply.error === "App context must wait until the current turn finishes") {
      return { state: "pending", detail: "Codex is working; ping will wait for idle", reason: "busy" };
    }
    return { state: "unknown", detail: "Codex did not confirm the turn; check the task before retrying" };
  } catch {
    return submitted
      ? { state: "unknown", detail: "Codex delivery outcome unavailable; no automatic replay" }
      : { state: "pending", detail: "Codex local connection unavailable", reason: "offline" };
  } finally { ipc.close(); }
}
