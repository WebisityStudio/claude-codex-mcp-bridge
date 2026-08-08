# Autonomous Claude/Fable ↔ Codex orchestration

## Goal

Let a Claude Code session running Fable 5 coordinate one or more Codex workers without the user manually copying messages. Claude starts a Codex run through MCP, Codex works in an isolated worktree, and the tool returns the report to the same Claude turn. If Codex needs stronger reasoning, it returns a structured Fable question. The already-active Fable 5 coordinator answers and calls the continuation tool, so the exchange continues without user intervention.

## Critical runtime fact

MCP mailboxes cannot wake an idle desktop chat. The reliable pattern is therefore a long-lived Claude tool loop:

```text
User gives task to active Claude/Fable session
  → Claude calls bridge_orchestrate_codex
  → bridge starts/resumes a saved Codex CLI session
  → Codex completes OR asks Fable for help
  → tool result returns to the same Claude turn
  → Fable answers and calls bridge_continue_codex
  → Codex resumes with the answer
  → final report returns to Claude
```

Standalone Claude CLI subscription access currently returns HTTP 403 on this Mac, while the Claude desktop Code session has Fable 5 access. The orchestrator must not attempt to launch a separate Fable CLI. It deliberately routes hard questions back through the active Fable coordinator.

## What appears in the apps

- The original Claude Code conversation remains the coordinator and displays MCP tool calls/results.
- Codex runs use the official bundled Codex CLI and persist real Codex session IDs. They are stored under the same Codex host, but immediate visual appearance in the desktop thread list is host-version dependent and is not guaranteed.
- The orchestrator never injects input into, kills, restarts, or hijacks an already-running Claude or Codex GUI process.

## MCP tools

### `bridge_orchestrate_codex`

Input:

```json
{
  "coordinatorAgent": "claude-main",
  "projectPath": "/absolute/git/repo",
  "task": "bounded implementation task",
  "threadId": "invoice-fix",
  "useWorktree": true,
  "maxRounds": 6
}
```

Returns one of:

- `completed`: final report, files, tests, Codex session ID, worktree path.
- `waiting_for_fable`: exact question plus run ID. Fable should answer and call `bridge_continue_codex`.
- `blocked`: action requires user approval or cannot be completed safely.
- `failed`: adapter/runtime failure with recovery detail.

### `bridge_continue_codex`

Input: `runId` and Fable's answer. Resumes the same Codex session and worktree.

### `bridge_orchestration_status`

Returns durable run state and event history after a process/app restart.

## Codex response contract

Every Codex turn must return JSON matching:

```json
{
  "status": "completed | needs_fable | blocked",
  "summary": "short result",
  "evidence": ["commands/tests and outcomes"],
  "question": "required only for needs_fable",
  "filesChanged": ["relative/path"],
  "tests": ["command: result"],
  "suggestedChips": [
    {"title": "bounded child task", "task": "self-contained brief"}
  ]
}
```

When `suggestedChips` are returned, Claude may issue up to three independent `bridge_orchestrate_codex` calls. Each call creates a separate Codex session and worktree. This matches the old chip workflow without forcing unsafe automatic merging.

## State machine

```text
created
  → running_codex
  → waiting_for_fable → running_codex (bounded loop)
  → completed
  → blocked
  → failed
  → cancelled
```

State and events are persisted in the existing SQLite database. Every run records task, project, worktree, Codex session ID, round count, status, summaries, and timestamps. Secrets and raw environment values are never written.

## Isolation and safety

- Default to a git worktree under `<repo>/.bridge-worktrees/<slug>-<run-id>`.
- Create a local branch only. Never commit, push, merge, deploy, publish, send messages, change credentials, delete files, or perform production mutations.
- If the requested task needs any prohibited action, Codex returns `blocked` and Claude asks the user.
- Maximum 3 parallel chips, recursion depth 1, 6 Fable/Codex rounds, and 20 minutes per Codex turn.
- Preserve completed worktrees for inspection. Never auto-clean them.
- Use argument arrays with `spawn`, never shell interpolation.

## Failure recovery

- Codex session ID is captured from JSONL `thread.started` before parsing the final envelope.
- If the MCP server restarts, `bridge_orchestration_status` recovers the run from SQLite and `bridge_continue_codex` resumes the recorded Codex session.
- Invalid model output marks the run failed with the output path retained for diagnosis.
- A timed-out Codex process is terminated and the run is marked failed. It is never silently retried because a retry could duplicate edits.
- Round-limit exhaustion becomes `blocked`, not an infinite loop.

## TDD plan

1. Store tests for run creation, event persistence, updates, and recovery.
2. Orchestrator test: Codex asks Fable, continuation resumes the same session, then completes.
3. Guard test: continuation is rejected when run is not waiting for Fable.
4. Guard test: maximum rounds stop the loop.
5. Adapter parser tests for JSONL session IDs and final envelopes.
6. MCP integration test confirms all orchestration tools are discoverable.
7. Live read-only smoke test with Codex asking Fable a harmless architecture question, followed by continuation and completion.
