<p align="center">
  <a href="https://www.webisitystudio.co.uk/">
    <img src="assets/webisity-studio-logo.svg" width="180" alt="WebiSity Studio logo">
  </a>
</p>

<h1 align="center">Claude Codex MCP Bridge</h1>

<p align="center">Built by <a href="https://www.webisitystudio.co.uk/">WebiSity Studio</a></p>

[![CI](https://github.com/WebisityStudio/claude-codex-mcp-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/WebisityStudio/claude-codex-mcp-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

<p align="center">
  <img src="assets/bridge-demo.gif" alt="Claude Codex MCP Bridge send, wait, wake and acknowledge demo" width="900">
</p>

A local MCP bridge for Claude Code and OpenAI Codex. It gives a team of Claude and Codex conversations a durable SQLite mailbox, background pings between them, and saved Codex workers that run in a pinned sandbox and report back on their own.

```text
Claude Code ──stdio MCP──┐
                         ├── local SQLite WAL store (private to your user)
Codex       ──stdio MCP──┘
```

The default mode has no account, cloud relay, HTTP server or listening network port.

## Why

Plain MCP tools are request-response. Writing a message to a mailbox does not automatically start a new model turn in another chat. The bridge supports three patterns:

1. **Background pings (experimental, macOS):** bind each conversation once with `wake: "auto"`; a durable message pings an idle recipient through its app's local interface. If a ping cannot be delivered, the sender is told automatically. See [background setup and limits](docs/BACKGROUND-WAKE.md).
2. **Active waits:** agents without pings use `bridge_wait` before going idle. The pending call returns when a matching message arrives.
3. **Codex workers:** Claude calls `ask_codex`, `review_with_codex` or `bridge_orchestrate_codex`. The bridge starts a saved Codex session in an isolated worktree. If Codex needs longer than one tool call, the result arrives in the coordinator's mailbox when it finishes.

See [INSTRUCTIONS.md](INSTRUCTIONS.md) for copy-paste prompts.

## Features

- Local SQLite WAL mailbox with versioned, backed-up migrations and daily backups
- Direct messages, broadcasts, stable thread IDs and idempotency keys
- Recipient-scoped acknowledgements, an outbox of what others have not handled, and agent retirement that closes finished work with a recorded reason
- Recipient checks: unknown names are rejected with "did you mean" suggestions, and senders get warnings when a message is unlikely to be picked up
- Output paging so large inboxes and threads never overflow an MCP result
- Optional background pings with delivery receipts, a 24-hour window for busy recipients and automatic notices to the sender when a ping fails
- Codex workers with the sandbox pinned on every turn, read-only reviews, bridge-observed file changes and background completion through the mailbox
- Worktrees outside your repository, with an option to carry uncommitted changes in
- Recovery of Codex runs whose bridge process exited mid-turn
- A versioned runtime with smoke-tested installs and one-command rollback

## Tools

| Tool | Purpose |
|---|---|
| `bridge_register` | Register an agent; `wake: "auto"` binds this conversation for background pings |
| `bridge_send` | Save a message, ping a bound recipient, and warn about delivery risks |
| `bridge_inbox` | Read unread messages in pages that fit the host's output limit |
| `bridge_ack` | Acknowledge handled messages without deleting history |
| `bridge_wait` | Keep the current turn open until a matching message arrives |
| `bridge_thread` | Read a thread, newest page first, with cursors both ways |
| `bridge_outbox` | See which of your messages recipients have not handled, and why |
| `bridge_agents` | List agents with unread counts, last activity and ping health |
| `bridge_retire` | Retire a finished agent and close its unhandled messages |
| `bridge_sessions` | Discover live Claude sessions and this conversation's own session |
| `bridge_wake_status` | Inspect ping outcomes separately from acknowledgements |
| `ask_codex` | Send one bounded task to a Codex worker in an isolated worktree |
| `review_with_codex` | Run an evidence-led review in a read-only sandbox |
| `bridge_orchestrate_codex` | Start a Codex run with rounds, worktree and wait controls |
| `bridge_continue_codex` | Resume the same Codex session with the coordinator's answer |
| `bridge_orchestration_wait` | Wait for a running Codex run started by any bridge process |
| `bridge_orchestration_status` | Read durable run state and audit events |

## Requirements

- Node.js 22.5 or newer
- Claude Code
- OpenAI Codex CLI
- Git, for worktree isolation

The mailbox works anywhere Node and both MCP clients run. The Codex launcher uses `CODEX_BIN` when set, then the Codex binary bundled in the macOS ChatGPT app, then `codex` from `PATH`.

Core tests run on macOS, Linux and Windows in GitHub Actions. Background pings and the live Claude Desktop plus Codex Desktop workflow were developed and verified on macOS.

## Install

### One command

```bash
npx --yes --package=github:WebisityStudio/claude-codex-mcp-bridge claude-codex-mcp-bridge setup
```

Setup:

- installs the package as a new runtime version under `~/.local/share/claude-codex-bridge/runtime/versions/`;
- starts that runtime against a throwaway mailbox and checks its tools before activating it;
- points Claude Code and Codex at `runtime/current`, so updates and rollbacks never touch a checkout you are editing;
- edits only the bridge's own entry in Codex's `config.toml` (per-tool approval settings are kept, and a backup is written) and sets `tool_timeout_sec = 300` so waits are not cut at Codex's 60-second default;
- installs the `ask-codex`, `review-with-codex` and coordinator skills plus a `codex-teammate` Claude agent.

Setup keeps the Node.js binary your apps already launch the bridge with (pass `--node PATH` to choose another) and registers through the newest Claude Code bundled with the desktop app when present (`CLAUDE_BIN` overrides), so an older standalone `claude` on `PATH` never rewrites your Claude settings. Once installed, later updates only switch the `current` link; neither app's configuration changes again.

Open fresh Claude and Codex sessions afterwards. Running sessions keep the bridge they started with.

```bash
npx --yes --package=github:WebisityStudio/claude-codex-mcp-bridge claude-codex-mcp-bridge doctor
```

### From a checkout

```bash
git clone https://github.com/WebisityStudio/claude-codex-mcp-bridge.git
cd claude-codex-mcp-bridge
npm ci
npm run check
node dist/cli.js setup
```

`setup` refuses to install a `dist/` that is older than `src/`. Run `npm run build` first.

## Everyday use

After opening a fresh Claude session:

```text
/ask-codex investigate why the authentication tests are flaky
/review-with-codex focus on authentication and tenant isolation
```

Or ask Claude directly:

```text
Ask Codex to implement this change and verify it.
Have Codex review this repository for security regressions.
```

The project path defaults to the Claude session's project. A call waits up to four minutes. If Codex is still working, the call returns `running_codex` and the result arrives later in your mailbox from `bridge`, which also pings your conversation if it is bound. Do not start a duplicate run.

## Background pings

Bind each conversation once:

```json
{"agent": "review-claude", "wake": "auto"}
```

Claude sessions are detected automatically. For Codex, pass `{"app": "codex", "sessionId": "<task ID>"}` when `auto` cannot see the task ID. Then send normally, acknowledge after handling, and end the turn when no work remains. See [the background wake guide](docs/BACKGROUND-WAKE.md) for receipt states and limits.

When a ping cannot be delivered, the sender receives one automated notice from `bridge` explaining why and what to do. The most common cause is Claude Code holding messages for sessions that run in Bypass permissions (its `crossSessionInbound` setting). The bridge explains this but never changes that setting.

## Fallback: active waits

Pick one canonical thread ID, register unique names, send with `bridge_send`, and wait with:

```json
{
  "agent": "claude-main",
  "fromAgent": "codex-main",
  "threadId": "invoice-review-001",
  "timeoutSeconds": 285,
  "acknowledge": true
}
```

Most MCP hosts cut tool calls near five minutes, so waits are capped at 290 seconds. Renew a timed-out wait while the task is active. A filtered wait only wakes for the exact sender and thread.

## Codex workers in detail

```json
{
  "projectPath": "/absolute/path/to/repository",
  "task": "Implement and test the bounded change",
  "threadId": "feature-x",
  "useWorktree": true,
  "includeUncommitted": false,
  "maxRounds": 6,
  "waitSeconds": 240
}
```

- Implementation runs use the `workspace-write` sandbox with network access off. Reviews use `read-only`. The sandbox is pinned on every turn, including resumed ones, so a permissive default in your own Codex config never applies to bridge workers.
- Worktrees live under `~/.local/share/claude-codex-bridge/worktrees/` (or `BRIDGE_WORKTREE_ROOT`). They stay out of your repository, so Metro, `tsc`, Jest and `git status` never see them.
- Worktrees start from `HEAD`. When the main checkout has uncommitted changes, the result warns you; pass `includeUncommitted: true` to copy them in.
- Every result includes `observedChanges`, the bridge's own `git status` of the workspace, next to what Codex reports.
- If the status is `waiting_for_fable`, answer the question and call `bridge_continue_codex` with the same run ID.
- Codex turns run as detached processes. If the bridge process that started one exits, another bridge process adopts the run, finishes it from its files and delivers the result.
- `BRIDGE_CODEX_CONFIG` can tune bridge workers without touching your interactive defaults, for example `model_reasoning_effort="medium"`. Sandbox and approval keys are ignored.

The bridge does not commit, push, merge, deploy or clean worktrees.

## Maintenance

```bash
claude-codex-mcp-bridge doctor          # installation, mailbox health, ping delivery, permissions
claude-codex-mcp-bridge doctor --fix    # also tighten mailbox file permissions
claude-codex-mcp-bridge status          # size, backlog, runs, latest backup
claude-codex-mcp-bridge prune           # list agents idle for 7+ days (dry run)
claude-codex-mcp-bridge prune --apply   # retire them and close their unhandled messages
claude-codex-mcp-bridge retire <agent> --note "task merged"
claude-codex-mcp-bridge backup          # manual point-in-time copy
claude-codex-mcp-bridge rollback        # switch back to the previous runtime
claude-codex-mcp-bridge uninstall       # keeps mailbox data unless --purge
```

Retiring never deletes messages. Closed messages keep their history and a note saying why, recently active senders get one notice listing what was closed, and registering the name again reactivates it.

## Storage

```text
~/.local/share/claude-codex-bridge/bridge.sqlite     mailbox (owner-only)
~/.local/share/claude-codex-bridge/backups/          pre-migration and daily backups (7 kept)
~/.local/share/claude-codex-bridge/runs/             Codex turn files (event streams pruned after 30 days; results kept)
~/.local/share/claude-codex-bridge/worktrees/        Codex worktrees (never cleaned automatically)
~/.local/share/claude-codex-bridge/runtime/          installed runtime versions
```

Override the mailbox in both MCP configurations with `BRIDGE_DB_PATH`. All MCP processes must point to the same database. Set `BRIDGE_BACKUPS=0` to disable daily backups.

Schema changes are additive and versioned. Before migrating an existing mailbox, the bridge writes a backup. Older bridge processes that are still running keep working against the migrated database.

## Honest limitations

- Background pings use observed local app interfaces, not public APIs. They need the app and its session host running.
- Claude Code holds pings for sessions in Bypass permissions, and the desktop app has no prompt to approve them, so they expire. Sessions in other permission modes, or a deliberate `crossSessionInbound: "accept"` setting, avoid this. The sender is notified either way.
- Claude Code channels (`BRIDGE_CLAUDE_CHANNEL=1`) are supported as an opt-in push path, but Claude Code only listens when launched with its channel flags, which the desktop app does not expose.
- Codex does not expose its task ID to MCP servers in every version, so `wake: "auto"` may need the ID passed explicitly.
- Registration proves discovery, not active processing. Acceptance of a ping is not completion of the work.
- The transport is local to one machine.

## Safety

- No credentials are stored by this project. The Claude wake adapter reads only the addressed inbox's published peer token into memory and never logs it. It never uses child tokens or claims a permission mode.
- The mailbox, backups and Codex turn files are owner-only. Messages are stored unencrypted, so do not send secrets through the mailbox.
- Child processes receive a small allowlist of environment variables, not the full parent environment.
- Worker sandboxes are pinned per turn. Worker prompts prohibit commits, pushes, deployments, external sends, credential changes, deletion and production mutations unless separately approved.
- Messages from `bridge` are automated notices. Agents are told not to reply to them, and notices never trigger further notices.

## Development

```bash
npm run typecheck   # src, tests and scripts
npm test
npm run build       # compiles into dist.next/ and swaps it in
npm run check       # all of the above
npm audit --omit=dev --audit-level=high
BRIDGE_CODEX_CONFIG='model_reasoning_effort="low"' npm run smoke:orchestrator   # live Codex run, fully isolated
```

The suite covers socket framing, identity and permission boundaries, migrations from 0.3 databases and compatibility with running 0.3 processes, ping persistence, crash recovery and failure notices, mailbox routing, addressing checks, retirement, paging, independent MCP processes, detached Codex turns with a fake Codex binary, orphaned run recovery, real git worktrees, Codex config edits and runtime rollback.

## Related work

This is not the only Claude/Codex bridge. See [docs/ALTERNATIVES.md](docs/ALTERNATIVES.md) for a comparison with Claude Channels bridges, ACP delegation tools and general agent mailboxes.

## License

MIT
