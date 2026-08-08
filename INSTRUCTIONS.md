# Operating instructions

## Install and verify

```bash
npx --yes --package=github:WebisityStudio/claude-codex-mcp-bridge claude-codex-mcp-bridge setup
npx --yes --package=github:WebisityStudio/claude-codex-mcp-bridge claude-codex-mcp-bridge doctor
npx --yes --package=github:WebisityStudio/claude-codex-mcp-bridge claude-codex-mcp-bridge demo
```

Open fresh Claude and Codex sessions after setup.

## Everyday requests

The installer adds `/ask-codex`, `/review-with-codex`, `/claude-codex-coordinator` and a `codex-teammate` Claude agent.

```text
/ask-codex implement the requested change and run the relevant tests
/review-with-codex focus on security and regressions
```

Use the lower-level modes below only when you need visible multi-turn communication or several resumable workers.

The bridge supports two advanced workflows. Pick one and use one canonical thread ID from the start.

## Mode 1: two visible chats

Use this when Claude Code and Codex are both open and you want to watch them exchange messages.

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
5. Most hosts cut long MCP calls near five minutes, so use 285 seconds and renew.
6. MCP cannot cold-wake a GUI chat after its model turn has ended. Enter `bridge_wait` before going idle.

## Mode 2: Claude coordinates Codex workers

Use this when only Claude needs to stay open. Claude calls `bridge_orchestrate_codex`; the bridge starts a saved Codex CLI session and returns the result to the same Claude turn.

```text
Coordinate Codex autonomously for this task.

Use bridge_orchestrate_codex with:
- projectPath: <ABSOLUTE_REPOSITORY_PATH>
- threadId: <THREAD_ID>
- useWorktree: true
- maxRounds: 6

If Codex returns waiting_for_fable, answer the question and immediately call bridge_continue_codex with the same runId. Continue without asking me to relay messages.

Do not commit, push, merge, deploy, publish, send externally, change credentials, delete data, or mutate production without explicit approval.
```

Each independent worker gets its own Codex session, run ID, branch and worktree. The bridge preserves the output for review and does not merge it automatically.

## Stop conditions

Stop coordination when:

- the requested work is complete and verified;
- a real blocker requires the user;
- an external, destructive or security-sensitive action needs approval;
- the configured round limit is reached;
- the user explicitly stops the loop.
