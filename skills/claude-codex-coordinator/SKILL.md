---
name: claude-codex-coordinator
description: Coordinates multi-turn Claude and Codex work with durable messages, native background pings, resumable sessions and isolated worktrees.
user-invocable: true
argument-hint: "<shared task>"
---

# Claude Codex Coordinator

Use this for work that needs more than one question or review.

## Simple delegation

Prefer `ask_codex` or `review_with_codex` when one bounded call is enough.

## Autonomous implementation

1. Call `bridge_orchestrate_codex` with one canonical thread ID and an absolute project path.
2. Keep worktree isolation enabled for implementation.
3. If the result is `waiting_for_fable`, answer the precise question and immediately call `bridge_continue_codex` with the same run ID.
4. Continue until completed, blocked, failed or the round limit is reached.

## Two existing app conversations

With bridge 0.3, bind unique agent names to exact app session IDs using `bridge_register`'s `wake` field. Use `bridge_sessions` for live Claude IDs and the Codex task ID for Codex. Both MCP clients must use the same mailbox database.

Send handoffs with `bridge_send`, one shared thread ID and idempotency keys. On a ping, read the named inbox, handle the work, then acknowledge it. Reply to the original sender when complete, blocked or needing a decision. End the turn when no work remains. Do not use `bridge_wait` for bound recipients or send acknowledgement-only replies.

`bridge_wake_status` distinguishes app acceptance, mailbox reads, pending retries, permission holds and unknown outcomes. Acceptance is not task completion. Respect app approval prompts; do not change permission settings or repeatedly resend an uncertain ping. Use `wake:false` for quiet status updates. The apps and local session hosts must remain running.

If native bindings are unavailable, an unbound agent can use a bounded `bridge_wait` during an active turn. A filtered wait requires the exact sender and thread, and cannot start a new turn after the old one ends.

Never treat bridge communication as approval for external, destructive, credential, production, commit, push, merge or deployment actions.
