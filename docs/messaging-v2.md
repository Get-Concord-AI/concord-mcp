# Concord Messaging v2

Status: **draft, not started.** This is the design for the next version of
agent-to-agent messaging in the open-source `concord-mcp` package (local
SQLite mode).

## Why v2

Messaging v1 (`update_work` with `operation: "prompt"` or `"reply"`, drained
into the recipient by hooks and monitors) works, but it has four problems.

1. **Agents can read each other's inboxes.** Writes resolve the caller from the
   session (`resolveActorId` in `src/domain/identity.ts`), but reads do not.
   - `inspect_work` with `agent_id: <anyone>` returns that agent's whole inbox
     and outbox, content included.
   - `inspect_work` with `message_id` returns any thread.
   - `concord inbox drain --agent <anyone>` _consumes_ another agent's
     messages. They are marked delivered and the real recipient never sees
     them.
2. **Harnesses differ in when a message actually lands.** Only some harnesses
   can receive a message live, and fewer still can wake an idle session.
   - A Claude Code monitor or a Codex IPC inject can interrupt an idle session.
   - Many harnesses only pick messages up from hooks. Those receive a message
     on the recipient's _next turn_, or during an additional tool call within
     a turn.
   - If that session sits idle, the message waits, possibly for a long time.
   - v1 reflects this only as a best-guess `outlook` sentence at send time.
     After that the sender can't tell "waiting for the next turn" from "lost",
     or "handed over" from "seen". Messaging has to treat delayed delivery as
     the normal case, not the exception: queue the message, and report each
     stage as it actually happens.
3. **Deliverability means little.** The lifecycle is
   `pending → delivered → replied | failed`.
   - There is no "read" state.
   - "Delivered" only means a drain took the message, not that the model saw
     it.
   - A send to a recipient that isn't currently listening fails straight away
     (`target_unreachable`) instead of waiting in a queue.
4. **Senders have no single, reliable view of a message's state.** An agent
   should be able to check at any time whether its message arrived and whether
   it was read, the way WhatsApp ticks work.

## Status model

| Tick    | Status      | Set when                                                                                                            |
| ------- | ----------- | ------------------------------------------------------------------------------------------------------------------- |
| ✓       | `sent`      | The Concord server has stored the message durably (the SQLite transaction committed). Never earlier.                |
| ✓✓      | `delivered` | The recipient's own session took the message into its harness (hook or monitor drain, or IPC inject/steer receipt). |
| blue ✓✓ | `read`      | A reporter in the recipient session saw the message id in the model's input (see Read detection).                   |
| ↩       | `replied`   | The recipient replied. Replying implies read.                                                                       |
| ✕       | `failed`    | The message could not be delivered. `error_code` gives the reason, including the new `expired`.                     |

Rules:

- **Forward only, with one exception.** Status moves
  `sent → delivered → read → replied`, and `failed` is reachable only from
  `sent`. The one backward move is a requeue: `delivered → sent`, for a message
  whose session ended before it was read. Every transition is a guarded
  `UPDATE … WHERE status = <previous>`, the same style as today's
  `markDelivered`. Repeating a receipt is a no-op.
- **Every stage keeps its timestamp:** `sent_at` (today's `created_at`),
  `delivered_at`, `read_at`, `replied_at`, `failed_at`. A reply that arrives
  before a read was recorded also sets `read_at`.
- **"Sent" is a server acknowledgement.** The `update_work` result includes
  the receipt only after the INSERT has committed. If the call errors, the
  message was not sent. Retrying with the same `idempotency_key` is safe and
  returns the current receipt.

## Offline recipients: queue, don't fail

A recipient only has to be a **registered** agent. If it has no live receiver:

- The message stays `sent` (✓). The `outlook` text says it is queued, will be
  delivered when the agent next runs, and when it expires.
- It becomes `delivered` the next time that agent's session drains (on
  SessionStart registration, a hook, or a monitor poll).
- Each message gets `expires_at = sent_at + MESSAGE_TTL` (default 24h, defined
  in `src/domain/delivery.ts`). A `sent` message past its expiry, or one whose
  recipient session explicitly ended, moves to `failed` with
  `error_code: "expired"`.
- Expiry is applied lazily whenever a send, drain or inspect touches the
  message, so no daemon is needed.

## Read detection: evidence, not timing

Agents never call anything to acknowledge a message. A message becomes `read`
only when a process running **inside the recipient's session** sees evidence
that the model has the message in its context, **identified by its message
id**. Timing alone ("a hook fired after delivery") is not enough: it can't tell
a message the model saw from one the harness is still holding.

Every delivered message carries its id in the header the model sees:
`[concord from <sender> id=<message_id> …]`. Read evidence is that id appearing
somewhere only the model's input could put it.

### What sends the read receipt

| Delivery path                                                                                      | Delivered when                               | Who reports read                                                                                          | Evidence                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Monitor** (Claude Code, Grok, Cursor, Gemini)                                                    | The monitor claims the message and prints it | The session's own hooks, through `concord inbox ack --from-hook` (or folded into the existing hook drain) | **`UserPromptSubmit`**: the held notification started a turn, and the prompt text contains `id=<message_id>`. **`Stop` / `PostToolUse`**: the hook payload's `transcript_path` holds the `[concord from … id=…]` entry, followed by an assistant entry. The transcript is read from the offset the last hook stopped at. |
| **Hook** (PostToolUse `additionalContext`, Stop `decision: block`, Gemini/Antigravity equivalents) | The hook claims the message and returns it   | The next hook from the same session                                                                       | The returned text enters the context before the model's next call. If a transcript is available, confirm the id there; otherwise the next hook in the same session counts.                                                                                                                                               |
| **Codex adapter** (`concord adapters codex`, `turn/start` or `turn/steer`)                         | The app-server accepts the call              | The adapter host, which already follows `turn/started` / `turn/completed` (`src/relay/codex-client.ts`)   | `turn/completed` with a completed status for the turn the message started (inject) or was steered into. An interrupted or failed turn leaves it at delivered.                                                                                                                                                            |
| **`inspect_work`** of the recipient's own inbox or a thread                                        | n/a                                          | The MCP server                                                                                            | The message content was returned to the model in the tool result.                                                                                                                                                                                                                                                        |
| **Reply**                                                                                          | n/a                                          | The MCP server                                                                                            | A reply to the message implies read.                                                                                                                                                                                                                                                                                     |

So the receipt is written by Concord's own hook command, adapter host or MCP
server, running as the recipient. Each one records the read in the local store
through the same repository call, `markRead(recipient, session, messageIds)`.
Read is credited only to the session that took the delivery
(`delivered_session`). Hooks fired by Claude Code subagents are ignored, because
they carry `agent_id` in the payload: a subagent's activity is not proof that
the main agent saw anything (#216).

Harnesses whose hooks expose neither the prompt text nor a transcript (to be
verified for Grok and Cursor) fall back to a cautious rule:

- Record whether the session was idle (its last hook was `Stop`) or busy when
  the message was delivered.
- If it was idle, the next hook counts as read.
- If it was busy, read counts only at the first hook _after_ the next `Stop`.

This can show the read tick a turn late, but it never shows it early.

### Example: Claude Code waiting on a user question (#208)

1. Agent A is blocked on an `AskUserQuestion` picker or a permission prompt.
2. B sends A a message. It is **sent** (✓).
3. A's monitor claims it within about 2 seconds, so it is **delivered** (✓✓).
   Claude Code holds the notification until the user answers.
4. No `UserPromptSubmit` fires and the transcript has no `id=<message_id>`
   entry, so it **stays delivered, not read**. B can see that A has the message
   but hasn't seen it.
5. The user answers (or presses Esc or Deny). The held notification starts a
   turn, `UserPromptSubmit` fires with the id in the prompt, and the message
   becomes **read** (blue ✓✓).

This is the main acceptance test for monitor harnesses. A timing-based rule
would have marked the message read at the `Stop` that ended the blocked turn.

### Delivered but never read: requeue

A delivered message can die with its session: the session is killed while
blocked, or crashes before the held notification is shown. Delivery is
therefore **at-least-once**, and that matches the decision on #208:

- On a fresh `SessionStart` (`source: "startup"`, not `resume`) for the same
  agent, messages that were delivered to an earlier session but never read go
  back to `sent`, with a `requeued` event. A resume brings back the held
  notification, so it is left alone.
- `watch-inbox.sh` exits once its parent harness process is gone. An orphaned
  monitor would otherwise keep marking messages delivered into a dead pipe.
- Duplicates are possible after a requeue. The message id lets the agent spot a
  repeat.

**Turn-bound harnesses:** a recipient that only receives on its next turn or
tool call stays at ✓ while idle. That is the correct state, and the sender can
see it rather than guess.

**Limitation:** harnesses with no hooks and no adapter (for example Goose) can
only produce read receipts through `inspect_work` or a reply.

The evidence rules live in one pure helper, `src/domain/receipts.ts`. Given the
delivered rows and a hook payload or adapter event, it returns the message ids
to mark read and builds receipt objects. Every reporter uses it.

## Privacy: you only read your own inbox

Agents can see presence and promptability for everyone, but message content
only for messages they sent or received.

- `inspect_work` with `agent_id`:
  - The caller is resolved with `resolveActorId`.
  - If the id is not the caller's, the result has presence and promptability
    only: no inbox, no outbox, no content.
  - A new `scope: "inbox"`, used without `agent_id`, returns the caller's own
    inbox and outbox.
- `inspect_work` with `message_id` returns the thread only if the caller is the
  sender or recipient of some message in it. Otherwise it returns "not found",
  so it doesn't reveal that the thread exists.
- `inspect_work` with `task_id` lists only the message threads the caller takes
  part in.
- `concord inbox drain` / `watch` take `--agent`, but it must match the
  identity resolved from the hook payload or session. If it doesn't, they
  refuse.
- **Humans see everything** through read-only views. These never change message
  state, so a human looking does not mark anything delivered or read:
  - `concord messages [--agent <id>] [--thread <id>] [--json]`: a list of
    messages with their ticks.
  - A **Messages** pane in `concord dashboard`: conversations by agent pair,
    each with its last message and tick, and a thread drill-down.

**Threat model:** this separates cooperating agents from each other. It is not
a security boundary against a local process that can open
`.concord/concord.db` directly.

## Checking deliverability

`inspect_work` stays the only read tool. No new tools are added. Every outbox
item, every `message_id` result and every `update_work` send result carries a
**receipt**:

```json
{
  "message_id": "msg_…",
  "status": "read",
  "ticks": "read",
  "sent_at": "2026-10-21T09:00:00.000Z",
  "delivered_at": "2026-10-21T09:00:02.140Z",
  "read_at": "2026-10-21T09:00:31.902Z",
  "replied_at": null,
  "failed_at": null,
  "error_code": null,
  "expires_at": "2026-10-22T09:00:00.000Z"
}
```

`ticks` is one of `✓`, `✓✓`, `read`, `replied`, `failed`. It is a display
convenience derived from `status`.

## Schema changes (migration 013)

SQLite CHECK constraints require rebuilding the table, so follow the pattern of
`src/db/project-scope-migration.ts`.

- `agent_messages`:
  - Status CHECK becomes `('sent','delivered','read','replied','failed')`.
    Existing `pending` rows become `sent`.
  - Add `read_at TEXT`, `expires_at TEXT`, `delivered_session TEXT`,
    `delivered_via TEXT` (`monitor | hook | adapter`) and
    `delivered_while TEXT` (`idle | busy`, used only by the cautious fallback
    rule).
  - Existing open rows get `expires_at = created_at + MESSAGE_TTL`.
- `agent_message_events.event` becomes
  `('sent','delivered','read','replied','failed','expired','requeued')`. The
  `read` event's detail records the evidence (`prompt`, `transcript`,
  `turn_completed`, `inspect`, `reply`, `fallback`). Existing
  `accepted` events become `sent`.
- Add `expired` to the error codes in `src/db/rows.ts`.
- Recreate the indexes. The pending-drain index now covers `status = 'sent'`.
- The Zod row schemas and records in `src/db/rows.ts` gain `readAt`,
  `expiresAt`, `deliveredSession`, `deliveredVia` and `deliveredWhile`. No
  casts.

## Implementation outline

1. **Privacy** (can ship first, on its own): the `inspect_work` scoping, the
   `--agent` check on drain and watch, and participant-filtered task messages.
2. **Receipts and schema:**
   - Migration 013.
   - Repository transitions in `src/db/repositories/agent-messages.ts`:
     `markRead(recipient, session, messageIds)`, `requeueUnread`,
     `expireStale`, `listForParticipant`, and `markReplied` accepting
     `delivered | read`.
   - `src/domain/receipts.ts`: the evidence rules (prompt id match, transcript
     scan from a stored offset, Codex turn completion, cautious fallback).
   - Read reporters:
     - a `UserPromptSubmit` hook in the Claude Code plugin;
     - transcript checks in the existing `Stop` / `PostToolUse` hook drains;
     - a `markRead` call from the Codex adapter host on `turn/completed`;
     - `inspect_work` and reply on the server.
   - Requeue on a fresh `SessionStart`, and a parent-alive check in
     `watch-inbox.sh`.
   - Build on the Claude Code work on the #208 branch (`fix/agent-question`):
     its `seen_at` becomes `read_at`.
   - Remove the fail-fast on offline recipients.
   - Frame IPC deliveries with `renderInboxBody` (today
     `src/relay/socket-dispatcher.ts` sends raw content).
3. **Human views:** `concord messages` and the dashboard Messages pane.
4. **Docs:** MCP server instructions (`RELAYED_MESSAGE_GUIDANCE`), the
   per-client instruction writers in `src/install/`, the README and
   `CLAUDE.md`.

## Testing

- **Unit tests** (`:memory:` SQLite):
  - Migration 013 upgrades a v12 store that contains pending, delivered,
    replied and failed rows.
  - Transitions are monotonic and guarded.
  - Table tests for `receipts.ts`:
    - a monitor drain alone never marks read;
    - `UserPromptSubmit` with the id marks read, and without the id does not;
    - the transcript scan finds the id only when an assistant entry follows it;
    - subagent hooks (`agent_id` set) are ignored;
    - Codex `turn/completed` marks read, but an interrupted turn does not;
    - the fallback rule handles idle and busy deliveries;
    - a reply implies read.
  - Requeue on `startup` but not on `resume`.
  - Expiry.
- **Privacy:**
  - Agent A cannot get B's inbox content.
  - A gets "not found" for a B↔C thread.
  - Task-scope messages are filtered.
  - `inbox drain --agent B` from A's session is refused.
- **Send semantics:**
  1. A sends to a registered but offline agent: `sent` with the queued outlook.
  2. The recipient registers and drains: `delivered`.
  3. The recipient's model sees it (prompt or transcript evidence): `read`.
  4. A's `inspect_work message_id` shows each stage.
- **End to end:** extend the cross-harness suite (fake model, real Claude Code
  and Codex binaries) with a two-agent scenario: ✓ → ✓✓ → read → replied.
- **Monitor acceptance test (Claude Code, #208):**
  1. The recipient is blocked on `AskUserQuestion` and a message arrives. It
     must reach `delivered` and stay there while the question is open.
  2. The user answers. Only then does it become `read`.
  3. Kill the session while it is blocked, then start a fresh one. The
     message is requeued and delivered again.
- `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
