---
name: review-with-codex
description: Asks Codex for a read-only evidence-led review of the current repository or a named subsystem.
user-invocable: true
argument-hint: "[review focus]"
---

# Review with Codex

Use the `review_with_codex` MCP tool.

1. Put the user's requested focus in `focus`. If none was provided, request a general correctness, security and regression review. The project defaults to this session's project.
2. Codex runs in a read-only sandbox. If the result warns that the workspace changed during the review, tell the user before relying on it.
3. If the status is `running_codex`, the review arrives in your mailbox from `bridge`, or call `bridge_orchestration_wait` with the run ID.
4. Verify each reported finding against the local files before presenting it as fact.
5. Present findings by severity with file and line references. Say directly when there are no substantive findings.
6. Ask for separate approval before making changes, committing or pushing.
