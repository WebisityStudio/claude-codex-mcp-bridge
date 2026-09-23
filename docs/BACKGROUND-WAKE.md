# Background wake-up (experimental, macOS)

Background pings connect existing local app conversations. The model can end its turn. A small dispatcher inside every bridge MCP process delivers pending pings; no third model, scheduled AI task, WebSocket service, window navigation or simulated keyboard input is involved.

## Connect two conversations

Both MCP servers must use the same SQLite database (setup configures this). Register each conversation once with a unique agent name:

```json
{"agent": "review-claude", "wake": "auto"}
```

`auto` binds the conversation hosting this bridge process. Claude Code exposes its session ID to MCP servers, so Claude sessions are detected automatically. Codex does not expose its task ID in every version; if `auto` reports that it cannot detect the session, pass it explicitly:

```json
{"agent": "review-codex", "wake": {"app": "codex", "sessionId": "<CODEX_TASK_ID>"}}
```

`bridge_sessions` lists live Claude sessions and shows `thisSession` when it is known. Claude accepts either the internal session UUID or its desktop bridge session ID.

Then call `bridge_send` normally. The mailbox message and its wake job commit in one SQLite transaction. Sending with the same sender/idempotency key returns the original message and cannot create another ping. A `wake:false` send, broadcast or self-message is silent.

Pings show the sender, message ID and a short preview in the recipient conversation. The complete message and delivery history remain in SQLite.

On a ping, read the named inbox, handle the work, then acknowledge it. Reply to the original sender on the same thread when complete, blocked, or needing a decision. End the turn when no work remains. Do not send acknowledgement-only pings.

Omitting `wake` from registration preserves the current binding. `wake: null` disables future pings and cancels pending ones. An agent name cannot silently move to another live conversation; unbind first or choose a new name. If the previously bound Claude session is no longer running, registering again from the new session moves the binding. Already dispatched input cannot be recalled.

## Delivery evidence

`bridge_wake_status` returns up to 100 recent jobs with a per-state summary, optionally filtered by agent.

| State | Meaning |
|---|---|
| pending | App unavailable or recipient mid-turn; eligible for retry |
| sending | One dispatcher owns this attempt |
| accepted | App confirmed admission or a new turn; the work is not necessarily done |
| read | A bridge inbox read fetched the message; acknowledgement is still separate |
| held | Claude retained the ping without admitting it to the model |
| refused | Unsupported protocol, or Claude declined, dropped or expired the message |
| unknown | Input may have arrived, but no positive receipt was received |
| cancelled | Recipient unbound, retired, or the message was acknowledged before dispatch |
| expired | The retry window elapsed; the mailbox message is preserved |

Dispatchers check for due jobs every two seconds, with per-job exponential backoff up to one minute. A ping for an unreachable recipient is kept for one hour. A ping for a Codex task that is merely busy is kept for 24 hours, because the app's own idle check makes later delivery safe. A closed MCP process leaves the outbox for the next one. Failed or lost confirmations after submission are never replayed automatically.

## When a ping fails, the sender is told

When a ping ends `refused`, `expired` or `held`, the bridge sends the original sender one automated message from `bridge`. It names the message, explains the cause and suggests next steps. The message itself stays unread in the recipient's inbox. Notices are coalesced to one per sender and recipient per half hour, are never sent to unregistered or retired senders, and a failed notice never produces another notice. Senders can see everything still unhandled with `bridge_outbox`.

`bridge_send` also warns at send time when the last three pings to a recipient failed, when a bound Claude session is not running, or when an unbound recipient has been idle for a day.

## Why Claude pings expire

Claude Code gates cross-session input by permission mode. When the recipient session runs in **Bypass permissions** and the sender does not state a permission mode, the message is held for the user's approval (Claude Code calls this a permission-mode parity hold). A terminal session shows it for review. The desktop app has no approval surface for it, so it expires. Claude Code's `crossSessionInbound` setting controls this: `"accept"` delivers held messages.

The bridge does not state a permission mode, because it has none. Claiming one would let any local process inject input into a bypass session. So the options belong to the user:

- run recipient Claude sessions in a permission mode other than Bypass;
- approve held messages in a terminal session; or
- deliberately set `"crossSessionInbound": "accept"` in `~/.claude/settings.json`, accepting that local peers can then deliver messages to bypass sessions without review.

`claude-codex-mcp-bridge doctor` reports how many recent Claude pings were held or expired and the current `crossSessionInbound` value. It never changes it.

## Claude Code channels (opt-in)

Claude Code channels let an MCP server push events into the session that launched it. Set `BRIDGE_CLAUDE_CHANNEL=1` in the bridge's Claude MCP environment and start Claude Code with `--dangerously-load-development-channels server:claude-codex-bridge` (or `--channels` once the server is allowed). The bridge then declares the `claude/channel` capability. Pings for that session are pushed through the channel by the session's own bridge process, and other processes skip them while its heartbeat is fresh.

Channels are a research preview. Claude Code returns no receipt for channel events, so they are recorded as `unknown` until the recipient reads its inbox. The desktop app does not currently expose the launch flags, so this mode applies to terminal sessions.

## App interfaces and limits

These are observed local app interfaces, not stable public APIs:

- **Codex:** connects to the private app IPC socket, initializes as a bridge client, discovers the exact task's owner, and requires `supportsUntrustedAppInput`. A ping enters as an `untrusted_input` tool result through the native follower start-turn path. Existing model, permission and workspace settings are inherited. The native idle guard defers a ping while a turn is active.
- **Claude:** resolves a live process through the local session registry, checks the UID and UTC process start time, and uses its private messaging socket. Only the inbox's published peer authentication capability is used, in memory. Child tokens, bypass claims and permission overrides are never used. A private temporary reply socket receives correlated receipts.

The apps and their local session hosts must remain running. Launching a stopped app or resurrecting an absent Claude worker is not implemented. Unavailable sessions keep unread messages. Remote conversations and other machines are out of scope.

Claude's normal tool approvals still apply after waking. The bridge does not grant approval or change app security settings.

## Isolated verification

`scripts/mailbox-request.ts` is a development MCP client that requires an explicit absolute database path. It starts this repository's server with that database and never defaults to the live mailbox:

```bash
node --import tsx scripts/mailbox-request.ts /absolute/test/bridge.sqlite bridge_inbox '{"agent":"test-agent"}'
```

A short-lived client does not keep retrying after it closes. App-connected MCP servers keep the background dispatcher.

Because live clients run the stable runtime installed by setup, rebuilding a checkout never changes the bridge that running sessions use.

The regression suite uses temporary databases and real local sockets to cover identity checks, peer authentication, held and refused receipts, exact Codex targeting, untrusted input, fragmented frames, response loss, single ownership, crash recovery, busy and offline retry windows, sender notices, channel routing and duplicate suppression. No test requires an app account or sends a message to a real conversation.
