# Background wake-up (experimental, macOS)

Version 0.3 adds opt-in pings between existing local app conversations. The model can end its turn. A small dispatcher inside the MCP server delivers pending pings; no third model, scheduled AI task, WebSocket service, window navigation or simulated keyboard input is involved.

## Connect two conversations

Both MCP servers must use this build and the same SQLite database. Discover Claude's live local sessions with `bridge_sessions`. Use the exact Codex task ID from its app. Claude accepts either the internal session UUID or its desktop bridge session ID; the desktop ID survives a worker restart better.

Register each conversation once with a unique agent name:

```json
{"agent":"review-claude","wake":{"app":"claude","sessionId":"<CLAUDE_SESSION_ID>"}}
```

```json
{"agent":"review-codex","wake":{"app":"codex","sessionId":"<CODEX_TASK_ID>"}}
```

Then call `bridge_send` normally. The mailbox message and its wake job commit in one SQLite transaction. Sending with the same sender/idempotency key returns the original message and cannot create another ping. A `wake:false` send, broadcast or self-message is silent.

Pings display the sender, message ID and a short message preview in the recipient conversation. The complete message and delivery history remain in SQLite. Wake status also includes the acknowledgement timestamp.

On a ping, read the named inbox from the database identified by `mailboxPath`, handle the work, then acknowledge it. Reply to the original sender on the same thread when complete, blocked, or needing a decision. End the turn when no work remains. Do not send acknowledgement-only pings.

Omitting `wake` from registration preserves the current binding. `wake:null` disables future pings and cancels pending ones. An agent name cannot silently move to another conversation; unbind first or choose a new name. Already dispatched input cannot be recalled by unbinding.

## Delivery evidence

`bridge_wake_status` returns up to 100 recent jobs, optionally filtered by agent.

| State | Meaning |
|---|---|
| pending | App unavailable or Codex still working; eligible for retry |
| sending | One dispatcher owns this attempt |
| accepted | App confirmed admission/start; the work is not necessarily done |
| read | A bridge inbox request fetched the message; acknowledgement is still separate |
| held | Claude has retained the peer message without admitting it; this does not guarantee the desktop shows an approval card |
| refused | Unsupported protocol or Claude declined/dropped the message |
| unknown | Input may have arrived, but no positive receipt was received |
| cancelled | Recipient unbound or message acknowledged before dispatch |
| expired | One-hour automatic retry window elapsed; mailbox message is preserved |

The MCP process checks for due jobs every two seconds, with per-job exponential backoff up to one minute. The dispatcher requires at least one connected MCP server process, not an active model turn. A closed MCP process leaves the outbox for the next one. Failed or lost confirmations after submission are never automatically replayed. Held messages remain subject to Claude's own approval UI.

Claude 2.1.260 does not send a positive peer receipt for every immediately accepted message. Such a send may initially show `unknown`; the recipient's `bridge_inbox` request changes it to `read`. Socket closure alone is never reported as successful processing.

## App interfaces and limits

These are observed local app interfaces, not stable public APIs:

- **Codex:** connects to the private app IPC socket, initializes as a bridge client, discovers the exact task's owner, and requires `supportsUntrustedAppInput`. A ping enters as an `untrusted_input` tool result through the native follower start-turn path. Existing model, permission and workspace settings are inherited. The native idle guard defers a ping while a turn is active.
- **Claude:** resolves a live process through the local session registry, checks the UID and UTC process start time, and uses its private messaging socket. Only the inbox's published peer authentication capability is used in memory. Child tokens, bypass claims and permission overrides are never used. The target's internal session ID is included to reject stale addressing. A private temporary reply socket receives correlated peer receipts.

The apps and their local session hosts must remain running. Ending a model turn is supported; launching a stopped app or resurrecting an absent Claude worker is not implemented. Unavailable sessions retain unread messages. Remote/cloud conversations and machines are outside this adapter's scope.

Claude's peer-input gate is separate from its tool-approval cards. In the tested desktop runtime, switching the recipient to Bypass permissions caused unclassified peer input to be held without a visible card. Approving shell commands does not approve that incoming peer message. Do not resend, impersonate a bypass-capable sender, or change permission settings automatically. A user-approved return to Manual mode can be tested as the narrower recovery.

Claude's normal tool approvals also still apply after waking. A successful wake can lead to a command approval prompt, exactly as a manually started turn can. The bridge does not grant approval or change app security settings.

## Isolated verification

Use `npm run check:wake` to build the candidate into `dist-wake/` and run the suite when installed clients point at this checkout's `dist/server.js`. This avoids replacing their compiled runtime during testing.

`scripts/mailbox-request.ts` is a development MCP client requiring an explicit absolute database path. It starts this repository's server with that database and never defaults to the live mailbox. This allows a separate test conversation and mailbox without replacing an installed bridge.

```bash
node --import tsx scripts/mailbox-request.ts /absolute/test/bridge.sqlite bridge_inbox '{"agent":"test-agent"}'
```

A short-lived client does not keep retrying after it closes. Normal app-connected MCP servers retain the background dispatcher.

The regression suite uses temporary databases and real local sockets to cover identity checks, peer authentication, held/refused receipts, exact Codex targeting, untrusted input, fragmented frames, response loss, single ownership, crash recovery and duplicate suppression. No test requires an app account or sends a message to a real conversation.
