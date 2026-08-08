---
name: review-with-codex
description: Asks Codex for a read-only evidence-led review of the current repository or a named subsystem.
user-invocable: true
argument-hint: "[review focus]"
---

# Review with Codex

Use the `review_with_codex` MCP tool.

1. Resolve the repository to an absolute path.
2. Put the user's requested focus in `focus`. If none was provided, request a general correctness, security and regression review.
3. Treat the run as read-only. Do not ask Codex to fix findings in the review call.
4. Verify each reported finding against the local files before presenting it as fact.
5. Present findings by severity with file and line references. Say directly when there are no substantive findings.
6. Ask for separate approval before making changes, committing or pushing.
