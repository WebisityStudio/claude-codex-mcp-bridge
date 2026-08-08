# Related projects and positioning

Similar projects exist. This bridge is not presented as the first Claude and Codex integration.

Checked on 8 August 2026:

| Project | Main approach | Difference from this bridge |
|---|---|---|
| [codex-claude-bridge](https://github.com/abhishekgahlot2/codex-claude-bridge) | Claude Code Channels for push into Claude, blocking MCP on Codex, plus a web UI | Stronger Claude-side push. Requires Channels and a local HTTP service. This project stays local stdio plus SQLite and includes durable orchestration/worktrees. |
| [claude-codex](https://github.com/fuergaosi233/claude-codex) | Implements the Codex app-server protocol so the Codex desktop remote surface runs Claude Code | A desktop runtime adapter, not a shared mailbox between independent Claude and Codex agents. |
| [agent-delegate-bridge](https://github.com/Ming0429/bridge-mcp-server) | Delegates to Claude CLI and Codex through ACP | Focused on starting delegated CLI tasks rather than durable threaded messaging between existing clients. |
| [Agent Bridge](https://github.com/creatornader/agent-bridge) | General local and cross-machine agent messaging with SQLite/PostgreSQL | Broader and more production-oriented. This project is smaller and specialised for Claude/Fable plus saved Codex orchestration. |
| [agent-mailbox-mcp](https://github.com/lleontor705/agent-mailbox-mcp) | General MCP/A2A mailbox, task lifecycle, dashboard and HTTP mode | Broader messaging infrastructure. This project adds the direct Codex session/worktree continuation loop. |
| [claude-peers-mcp](https://github.com/hinescreative/claude-peers-mcp) | Claude Channels and a broker for peer discovery across machines, with Codex polling | Fleet-oriented broker. This project defaults to one-machine stdio processes and no network listener. |

## What this project focuses on

- No account, HTTP service or listening network port in the default mode
- One local SQLite WAL store shared by independent stdio MCP processes
- Durable threads, recipient-scoped acknowledgements and idempotent sends
- A blocking `bridge_wait` tool for active two-chat coordination
- Saved Codex CLI sessions that can be resumed after a Fable decision
- Optional isolated Git worktrees for implementation workers
- Round limits, audit events and explicit approval boundaries

Choose another project if you need Claude Channels push, a hosted cross-machine gateway, A2A protocol support or a web dashboard. Choose this one when you want a small local bridge plus a bounded Claude-to-Codex implementation loop.
