# Changelog

## 0.5.0 — 2026-11-09

- Worker chats in both apps, with choices inside an owner-set ceiling:
  - New `ask_claude` starts a headless Claude Code chat with a chosen folder, model, reasoning effort and permission mode (`plan`, `manual`, `acceptEdits`, `auto`). With `showInDesktop` the finished chat is opened in the Claude desktop app.
  - `ask_codex`, `review_with_codex` and `bridge_orchestrate_codex` accept `model` and `reasoningEffort`; the first and last also accept `sandbox`.
  - Codex workers now run through `codex app-server`, so the Codex app lists their chats and `appLink` opens one. `BRIDGE_CODEX_RUNNER=exec` restores `codex exec`.
  - `policy.json` caps models, reasoning effort, sandbox, permission mode, folders, desktop hand-off and worker chats per hour (default 12). Requests above it are refused with the limit named. `claude-codex-mcp-bridge policy` shows it; `doctor` checks it and the Claude CLI sign-in.
  - `bridge_continue_run` continues a Codex or Claude worker; `bridge_continue_codex` remains as its earlier name.
  - Full access (Codex `danger-full-access`, Claude bypass permissions) is never offered to workers.
- Fixed: the bridge looked for the Codex and Claude Code builds bundled with the desktop apps at paths the apps no longer use, and silently fell back to older copies on `PATH`. Both current layouts are now found.
- Waiting calls now notice when their caller has gone (the turn was stopped, the host timed the call out, or the host process disappeared). A `bridge_wait` without a caller no longer acknowledges messages that arrive afterwards, so they stay unread. A Codex result that finishes after its caller cancelled is posted to the coordinator's mailbox instead of being claimed for nobody.
- The bridge shuts down when its host closes the input pipe without sending a signal.
- `bridge_agents` and `bridge_wake_status` now return pages that fit the host's output limit, like inbox and thread reads. With about 200 active agents they had grown to more than 100,000 characters each.
  - `bridge_agents` lists the most recently active agents first, 50 by default, with `total`, `hasMore` and `nextOffset`; `query` finds agents by name or capability. Empty fields are left out.
  - `bridge_wake_status` lists 20 receipts by default (`limit` up to 100) and pages back with `beforeId`. The summary still covers the latest 100 receipts. Previews are 120 characters, and the mailbox path appears once instead of on every receipt.

## 0.4.1 — 2026-10-31 (not published to npm)

- Update affected dependencies and ship npm-shrinkwrap.json so setup installs the reviewed dependency tree.
- Require patched Node 22.23.4, 24.22.1 or 26.12.1 within their supported major lines; cover all three in CI.
- Bound aggregate MCP inputs, message/task text and collection sizes before persistence.
- Disable executable Git helpers during preparation and reject untracked symlink/special-file copies. LFS/custom-filter checkouts may require trusted preparation.
- Add input-boundary and repository-helper regressions; retain existing mailbox schema and runtime rollback behavior.

## 0.4.0

Driven by field use of the 0.3 mailbox with dozens of agents: Claude pings that expired instead of waking anyone, direct messages that were never acknowledged, messages sent to names that never registered, threads that outgrew MCP output limits, and Codex workers that were rarely used because calls outlived host timeouts.

### Safety

- Resumed Codex turns no longer inherit the user's `config.toml` sandbox. Before this release, `bridge_continue_codex` ran `codex exec resume` without a sandbox setting. On a machine whose default is `danger-full-access`, resumed workers ran unsandboxed. The sandbox is now pinned on every turn, and a live smoke test checks Codex's own rollout.
- `review_with_codex` runs in a read-only sandbox instead of relying on its prompt, and warns if the workspace changed.
- The mailbox, its WAL/SHM files, backups and Codex turn files are owner-only (`0600`/`0700`). Existing files are tightened at startup, and `doctor --fix` fixes them on demand.
- `BRIDGE_CODEX_CONFIG` can tune worker model settings. It can never change sandbox, approval or environment policy.
- Dependencies updated past published advisories in `fast-uri` (high) and `qs` (moderate), both pulled in by the MCP SDK.

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

## 0.3.0

- Experimental background pings between existing Claude and Codex conversations on macOS: `bridge_register` binds an agent to an exact app session, and `bridge_send` pings a bound recipient through its app's local interface.
- Durable wake jobs committed with the message, idempotent sends that never ping twice, and `bridge_wake_status` receipts that keep delivery separate from acknowledgement.
- `bridge_sessions` discovers live Claude sessions. Quiet sends (`wake: false`), broadcasts and self-messages never ping.
- An explicit-database MCP client for isolated wake testing.

## 0.2.0

- One-command setup from GitHub with automatic Claude and Codex MCP registration.
- A stable per-user runtime installation, with no pasted absolute paths.
- `doctor`, `status`, `demo` and safe `uninstall` commands.
- `ask_codex` and read-only `review_with_codex` MCP tools.
- Three user-invocable skills plus a Codex teammate definition.
