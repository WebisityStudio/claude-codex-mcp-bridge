---
name: ask-codex
description: Sends one bounded implementation, investigation, or verification task to Codex without manually managing bridge threads.
user-invocable: true
argument-hint: "<task>"
---

# Ask Codex

Use the `ask_codex` MCP tool for the user's request.

1. Pass the user's task in `request` without diluting its acceptance criteria. The project defaults to this session's project; pass `projectPath` only for a different repository.
2. Keep the default worktree for implementation work. Use `useWorktree: false` only when the user explicitly wants work in the current checkout. Leave `model`, `reasoningEffort` and `sandbox` out unless the user asked or the task clearly needs them; the owner's policy caps them, and a refusal names the limit.
3. If the result warns about uncommitted changes and the task depends on them, run again with `includeUncommitted: true`.
4. If the status is `running_codex`, tell the user Codex is still working and carry on. The result arrives in your mailbox from `bridge`; you can also call `bridge_orchestration_wait` with the run ID. Never start a duplicate run.
5. If Codex returns `waiting_for_fable`, answer the question and continue with `bridge_continue_run` using the returned run ID.
6. Report changed files and real verification evidence. Compare Codex's `filesChanged` with the bridge's `observedChanges` before calling the work done. The chat is in the Codex app's list; pass on `appLink` when the user wants to open it.
7. Do not commit, push, merge, deploy, publish, send externally, alter credentials, delete data, or mutate production without explicit approval.
