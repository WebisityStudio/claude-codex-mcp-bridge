---
name: ask-claude
description: Sends one bounded task to a new Claude Code worker chat through the bridge, with a chosen model, reasoning effort and permission mode, and can open the finished chat in the Claude desktop app.
user-invocable: true
argument-hint: "<task>"
---

# Ask Claude

Use the `ask_claude` MCP tool for the user's request. It starts a new Claude Code chat in the background; no mailbox or thread management is needed.

1. Pass the user's task in `request` without diluting its acceptance criteria. The project defaults to this session's project; pass `projectPath` only for a different repository.
2. Pick `permissionMode` by what the task needs:
   - `plan` or `manual` to inspect, review or answer a question. Nothing can change, and the real checkout is read.
   - `acceptEdits` (the default) to change files. The work happens in an isolated git worktree.
3. Leave `model` and `effort` out unless the user asked for one or the task clearly needs it. The owner's policy caps what may be chosen and how many chats may be started. A refusal names the limit: ask for less or tell the user. Do not try to work around it.
4. Set `showInDesktop: true` only when the user wants to see the chat in the Claude desktop app. The app switches to that chat when it opens.
5. If the result warns about uncommitted changes and the task depends on them, run again with `includeUncommitted: true`.
6. If the status is `running_codex`, the worker is still going: tell the user and carry on. The result arrives in your mailbox from `bridge`; you can also call `bridge_orchestration_wait` with the run ID. Never start a duplicate run.
7. If the status is `waiting_for_fable`, answer the question and continue with `bridge_continue_run` using the returned run ID.
8. Report changed files and real verification evidence. Compare `filesChanged` with the bridge's `observedChanges`, and pass on any `warnings`, such as tool calls the permission mode refused.
9. Do not commit, push, merge, deploy, publish, send externally, alter credentials, delete data, or mutate production without explicit approval.

Claude workers run without MCP servers and need the Claude Code CLI signed in. If the tool reports a sign-in problem, tell the user to run `claude auth login` once; do not attempt it yourself.
