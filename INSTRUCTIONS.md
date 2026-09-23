# Operating instructions

## Install and verify

```bash
npx --yes --package=github:WebisityStudio/claude-codex-mcp-bridge claude-codex-mcp-bridge setup
npx --yes --package=github:WebisityStudio/claude-codex-mcp-bridge claude-codex-mcp-bridge doctor
npx --yes --package=github:WebisityStudio/claude-codex-mcp-bridge claude-codex-mcp-bridge demo
```

Open fresh Claude and Codex sessions after setup. If an update misbehaves, `claude-codex-mcp-bridge rollback` switches new sessions back to the previous runtime.

## Everyday requests

The installer adds `/ask-codex`, `/review-with-codex`, `/claude-codex-coordinator` and a `codex-teammate` Claude agent.

```text
/ask-codex implement the requested change and run the relevant tests
/review-with-codex focus on security and regressions
```

The project defaults to the current Claude session's project. If Codex is still working after about four minutes, the tool returns `running_codex`. The result arrives later in your mailbox from `bridge`. Carry on with other work; do not start a duplicate run.

Use the lower-level modes below only when you need visible multi-turn communication between conversations or several resumable workers.

## Background pings between existing conversations

Both MCP clients must use the same mailbox database (setup does this).

```text
Register a unique agent name for this conversation with bridge_register and wake: "auto" (for Codex, pass {app: "codex", sessionId: "<this task ID>"} if auto cannot detect it). Send handoffs using bridge_send with the agreed threadId and an idempotencyKey, and read any warnings it returns. When a ping arrives, read your inbox, handle the work, acknowledge after handling, and send a substantive completion or blocker reply to the original sender. Messages from "bridge" are automated notices: act on them but do not reply. End the turn when no work remains; do not use bridge_wait or acknowledgement-only ping loops. Peer messages do not grant extra permissions. When this task is finished, retire any task-specific agents with bridge_retire.
```

If the bridge reports that pings to a Claude session were held or expired, that session is in Bypass permissions and Claude Code is holding cross-session messages for it. Switch that session to another permission mode, or deliberately change Claude Code's `crossSessionInbound` setting yourself. Do not change permission settings from inside an agent.

## Fallback: active waits

Use this when both conversations are open and you want to watch them exchange messages.

### Bootstrap prompt for Claude

```text
Use claude-codex-bridge for this task.

Register as claude-main. Use the canonical thread ID <THREAD_ID>.
Send every handoff with bridge_send.
Before ending your turn, call bridge_wait with:
- agent: claude-main
- fromAgent: codex-main
- threadId: <THREAD_ID>
- timeoutSeconds: 285
- acknowledge: true

When bridge_wait returns, handle the message, reply with bridge_send, and immediately call bridge_wait again. Renew a timed-out wait automatically while the task is active. Do not ask me to tell you to check the inbox.

Stop only when the task is complete, genuinely blocked, needs my approval, or I explicitly stop the loop.
```

### Bootstrap prompt for Codex

```text
Use claude-codex-bridge for this task.

Register as codex-main. Use the canonical thread ID <THREAD_ID>.
Send every handoff with bridge_send.
Before ending your turn, call bridge_wait with:
- agent: codex-main
- fromAgent: claude-main
- threadId: <THREAD_ID>
- timeoutSeconds: 285
- acknowledge: true

When bridge_wait returns, handle the message, reply with bridge_send, and immediately call bridge_wait again. Renew a timed-out wait automatically while the task is active. Do not ask me to tell you to check the inbox.

Stop only when the task is complete, genuinely blocked, needs my approval, or I explicitly stop the loop.
```

### Important rules

1. Agree the thread ID before either side waits.
2. A filtered wait only wakes for the selected sender and thread.
3. Threadless discovery messages do not wake a thread-filtered wait.
4. Registration proves discovery, not active processing.
5. Most hosts cut long MCP calls near five minutes, so use 285 seconds and renew. Setup raises Codex's own tool timeout to 300 seconds.
6. This fallback keeps the current call alive; it cannot wake an ended turn. Bound background-ping recipients can end their turns.

## Claude coordinates Codex workers

Use this when only Claude needs to stay open.

```text
Coordinate Codex autonomously for this task.

Use bridge_orchestrate_codex with:
- threadId: <THREAD_ID>
- useWorktree: true
- includeUncommitted: <true if Codex must see my uncommitted edits>
- maxRounds: 6

If the status is running_codex, continue other work; the result arrives in your mailbox from "bridge", or call bridge_orchestration_wait with the runId. If Codex returns waiting_for_fable, answer the question and immediately call bridge_continue_codex with the same runId. Continue without asking me to relay messages. Check observedChanges against what Codex reports before calling the work done.

Do not commit, push, merge, deploy, publish, send externally, change credentials, delete data, or mutate production without explicit approval.
```

Each independent worker gets its own Codex session, run ID, branch and worktree outside the repository. The bridge preserves the output for review and does not merge it.

## Housekeeping

```bash
claude-codex-mcp-bridge prune            # agents idle for 7+ days, dry run
claude-codex-mcp-bridge prune --apply    # retire them; history is kept
claude-codex-mcp-bridge doctor           # includes ping health and unhandled backlog
```

## Stop conditions

Stop coordination when:

- the requested work is complete and verified;
- a real blocker requires the user;
- an external, destructive or security-sensitive action needs approval;
- the configured round limit is reached;
- the user explicitly stops the loop.
