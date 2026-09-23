# Autonomous Claude ↔ Codex orchestration

## Goal

Let a Claude Code session coordinate one or more Codex workers without the user copying messages. Claude starts a Codex run through MCP, Codex works in an isolated worktree, and the result comes back to Claude either in the same tool call or, for longer work, as a mailbox message. If Codex needs a decision, it returns a structured question; the coordinator answers and the same Codex session resumes.

## Flow

```text
User gives a task to an active Claude session
  → Claude calls ask_codex / review_with_codex / bridge_orchestrate_codex
  → bridge prepares the workspace and starts a detached Codex CLI turn
  → the call waits up to waitSeconds (default 240)
      finished → result returned in the same call
      still running → running_codex returned; the result is posted later to
                      the coordinator's mailbox from "bridge" (a bound
                      coordinator is pinged), or fetched with
                      bridge_orchestration_wait
  → waiting_for_fable → Claude answers → bridge_continue_codex
  → Codex resumes the same session, sandbox and worktree
  → completed / blocked / failed
```

Only one path hands a round's result over. The waiter and the background delivery both claim it atomically in SQLite, so the coordinator never receives the same round twice by accident. An explicit `bridge_orchestration_wait` after delivery still returns the result and says it was already posted.

## Sandbox

The sandbox is pinned on every turn with `-c sandbox_mode=...`, plus `--sandbox` on the first turn. `codex exec resume` has no `--sandbox` flag, and before 0.4 resumed turns silently fell back to the user's `config.toml` default. On the development machine that default was `danger-full-access`, so a resumed worker had no sandbox at all. A live smoke test now confirms from Codex's own session log that every turn runs `workspace-write`.

- Implementation runs: `workspace-write`, network access off.
- Reviews: `read-only`, in the live checkout. The bridge compares `git status` before and after, and warns if anything changed.
- `BRIDGE_CODEX_CONFIG` may tune the model or effort for workers. Keys that carry the safety boundary (`sandbox_mode`, `approval_policy`, `sandbox_workspace_write.*`, `sandbox_permissions`, `shell_environment_policy`) are dropped, and the pinned values come last.

## Workspace

- Worktrees are created under `~/.local/share/claude-codex-bridge/worktrees/<repo>-<hash>/<thread>-<run>` (or `BRIDGE_WORKTREE_ROOT`), outside the repository. Tools that scan the repository (Metro, `tsc`, Jest, ESLint, `git status`) never see them.
- A worktree starts from `HEAD`. If the main checkout has uncommitted changes, the run records a warning and tells Codex. With `includeUncommitted: true`, the bridge applies `git diff --binary HEAD` and copies untracked, non-ignored files into the worktree.
- A project path inside a repository maps to the same subdirectory inside the worktree.
- Every result carries `observedChanges`: the bridge's own `git status` of the workspace, alongside what Codex reports in `filesChanged`.
- Worktrees are never cleaned automatically.

## Durability and recovery

- Codex turns run as detached process groups whose output goes to files under `runs/`: the JSONL event stream, stderr and the final envelope.
- The Codex session ID is persisted as soon as it appears in the event stream, not only at the end.
- Each run records its owning bridge process (PID and start time) and the Codex child (PID and start time), so a reused PID is never mistaken for the original process.
- Every bridge process runs a reconciler every 15 seconds. A run whose owner has exited is adopted atomically. If Codex is still working, the new owner watches it; once it exits, the run is finished from its files. With no output, the run is marked failed as interrupted, with the worktree preserved. Either way the result is delivered.
- A turn that exceeds `BRIDGE_CODEX_TURN_TIMEOUT_MINUTES` (default 20) has its process group stopped and is marked failed. It is never retried silently, because a retry could duplicate edits.
- Round-limit exhaustion becomes `blocked`, not an infinite loop.
- Event streams and stderr logs older than 30 days are pruned by the daily housekeeping pass. Final result envelopes are kept.

## Codex response contract

Every turn returns JSON matching:

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

When `suggestedChips` are returned, Claude may start up to three independent runs, each with its own session, branch and worktree. Nothing is merged automatically.

## State machine

```text
created → running_codex → waiting_for_fable → running_codex (bounded loop)
                        → completed | blocked | failed
```

State and events live in the shared SQLite database: task, project, worktree, branch, base commit, sandbox, Codex session ID, rounds, owner and child processes, turn files, status, summaries, observed changes and warnings. Secrets and raw environment values are never written.

## Safety

- Worker prompts prohibit commits, pushes, merges, deployments, publishing, external messages, credential or configuration changes, deletion and production mutations. If one is needed, Codex returns `blocked` and Claude asks the user.
- Child processes get a small environment allowlist.
- Arguments go to `spawn` as arrays, never through a shell.
- At most three parallel chips, recursion depth one, twelve rounds maximum (six by default).

## Verification

- Unit and integration tests cover the question and resume loop, rejection of out-of-state continuations, round limits, background delivery exactly once, read-only change detection, failed background turns, pinned sandbox arguments, a real detached process driven by a fake Codex binary (including timeout and recovery from files), adoption of orphaned runs, and real git worktrees with uncommitted changes.
- `npm run smoke:orchestrator` runs the real Codex CLI end to end in a throwaway repository and mailbox, and fails if any turn in Codex's rollout ran outside `workspace-write`.
