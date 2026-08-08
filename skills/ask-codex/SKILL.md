---
name: ask-codex
description: Sends one bounded implementation, investigation, or verification task to Codex without manually managing bridge threads.
user-invocable: true
argument-hint: "<task>"
---

# Ask Codex

Use the `ask_codex` MCP tool for the user's request.

1. Resolve the current project to an absolute path.
2. Pass the user's task in `request` without diluting its acceptance criteria.
3. Keep `useWorktree: true` for implementation work. Use `false` only when the user explicitly wants work in the current checkout.
4. If Codex returns `waiting_for_fable`, answer the question and continue with `bridge_continue_codex` using the returned run ID.
5. Report changed files and real verification evidence.
6. Do not commit, push, merge, deploy, publish, send externally, alter credentials, delete data, or mutate production without explicit approval.
