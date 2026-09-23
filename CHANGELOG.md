# Changelog

## 0.4.0

Driven by field use of the 0.3 mailbox with dozens of agents: Claude pings that expired instead of waking anyone, direct messages that were never acknowledged, messages sent to names that never registered, threads that outgrew MCP output limits, and Codex workers that were rarely used because calls outlived host timeouts.

### Safety

- Resumed Codex turns no longer inherit the user's `config.toml` sandbox. Before this release, `bridge_continue_codex` ran `codex exec resume` without a sandbox setting. On a machine whose default is `danger-full-access`, resumed workers ran unsandboxed. The sandbox is now pinned on every turn, and a live smoke test checks Codex's own rollout.
- `review_with_codex` runs in a read-only sandbox instead of relying on its prompt, and warns if the workspace changed.
- The mailbox, its WAL/SHM files, backups and Codex turn files are owner-only (`0600`/`0700`). Existing files are tightened at startup, and `doctor --fix` fixes them on demand.
- `BRIDGE_CODEX_CONFIG` can tune worker model settings. It can never change sandbox, approval or environment policy.

### Delivery

- Root cause of expiring Claude pings documented: Claude Code holds cross-session messages for sessions in Bypass permissions (`crossSessionInbound`), and the desktop app has no approval surface for them. The bridge explains this in `bridge_send` warnings, `bridge_wake_status` and `doctor`, and never changes the setting.
- Failed, expired and held pings produce one automated notice to the sender, coalesced per recipient per half hour and loop-proof.
- Pings to a Codex task that is merely busy are kept for 24 hours instead of expiring after one.
- `wake: "auto"` binds the current conversation without copying session IDs. A binding moves automatically when its previous Claude session is no longer running.
- Opt-in Claude Code channel delivery (`BRIDGE_CLAUDE_CHANNEL=1`) for terminal sessions launched with channel flags.

### Mailbox

- `bridge_send` rejects unknown and retired recipients with "did you mean" suggestions (`allowUnregistered` overrides), and warns when a recipient is idle, unreachable or failing pings.
- New `bridge_outbox` shows what recipients have not handled, with ping state.
- New `bridge_retire` and CLI `retire`/`prune` close out finished agents. Their backlog is acknowledged with a recorded reason, history is kept, and active senders are told what was closed.
- `bridge_inbox`, `bridge_thread` and `bridge_wait` return pages sized to stay inside MCP output limits, with cursors, totals and an optional preview mode. Threads open at the newest messages.
- Re-registering without capabilities keeps the existing list. Agents' last activity is tracked from real usage.
- `bridge_wait` filters by sender and thread in SQL instead of re-reading the whole backlog on every poll.

### Codex workers

- Calls wait up to `waitSeconds` (default 240) and then return `running_codex`. The finished result is posted to the coordinator's mailbox exactly once. New `bridge_orchestration_wait` fetches it from any process.
- Codex turns run as detached processes writing to files. Session IDs are saved as soon as they appear. Runs whose bridge process exited are adopted, finished from their files or marked interrupted, and delivered.
- Worktrees live outside the repository. Runs warn when the main checkout has uncommitted changes, and `includeUncommitted` copies them in.
- Every result includes the bridge's own `observedChanges`.
- The project path and coordinator default to the current session's project and agent.

### Operations

- Versioned schema (`PRAGMA user_version`) with additive migrations, a backup before any migration, and compatibility with 0.3 processes still running.
- Daily mailbox backups (seven kept). Codex event streams are pruned after 30 days; result envelopes are kept.
- `setup` installs smoke-tested runtime versions behind an atomically switched `current` link, edits Codex's config in place (keeping per-tool approvals, with a backup) and sets a 300-second Codex tool timeout. New `rollback`, `backup`, `retire` and `prune` commands, and a fuller `doctor`.
- Setup keeps the Node.js binary already registered (or `--node PATH`) and smoke-tests with it, and registers through the newest desktop-bundled Claude Code instead of a possibly stale `claude` on `PATH`.
- Broadcasts reach agents that were registered when they were sent; late joiners no longer inherit weeks-old broadcasts as unread.
- `scripts/mailbox-request.ts` never runs development source against the live mailbox; live requests go through the installed runtime.
- `demo` retires its two demo agents when it finishes.
- Atomic builds: `dist/` is swapped in whole, never deleted first.
- Type checking now covers tests and scripts. The live smoke test runs fully isolated.
