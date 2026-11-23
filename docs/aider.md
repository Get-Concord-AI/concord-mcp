# Aider

Aider has no MCP client and no hook surface Concord can call — upstream
tracking is [Aider-AI/aider#5539](https://github.com/Aider-AI/aider/issues/5539),
still open — so there is no Concord adapter for it. What works today is
`concord work`: the CLI runs the same five workflow tools in-process over an
in-memory MCP transport, so every action is validated, attributed, and recorded
exactly like an MCP call.

`concord work` merged after the 0.23.0 release; check `concord work --help` —
if your install does not know the command, upgrade first. The README's
[Shell-only agents](../README.md#shell-only-agents-concord-work) section covers
the command surface itself; this page is the Aider-specific workflow.

## Identity

Aider sessions expose no id Concord can see, so you name the agent. Pick one
slug per session and reuse it on every command:

```sh
export CONCORD_AGENT_ID=aider:fix-login-bug
```

The `aider:` prefix becomes the agent kind automatically. Use a new slug for a
new session; reusing one continues the same identity, which is what you want
when picking a task back up but not across unrelated chats. Alternatively pass
`--agent aider:fix-login-bug` on each command — trusted here precisely because
no Concord session is visible to the shell.

## Workflow commands

| Intent          | Command                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| Claim work      | `concord work start --task TASK-1 --title "…" --files src/auth.ts`                                         |
| Read state      | `concord work inspect` · `concord work inspect --task TASK-1` · inbox view below                           |
| Record progress | `concord work update --task TASK-1 --type progress --content "…"`                                          |
| Message a peer  | `concord work update --json msg.json` (see below)                                                          |
| Hand off        | `concord work transfer --task TASK-1 --action offer --to agent:x --expected-version N --json handoff.json` |
| Finish          | `concord work finish --task TASK-1 --outcome review_ready --expected-version N --summary "…"`              |

Flags cover the common fields; `--json <file>` or `--json -` (stdin) passes the
full tool arguments as a JSON object for the rest — `operation`,
`to_agent_id`, `reply_to_message_id`, `idempotency_key`, `what_changed`,
`agent_id`. Every command prints the tool's structured result as JSON; a
failure prints `{"error": "…"}` on stdout, the message on stderr, and exits 1.

`finish` and mutating `transfer` actions require `--expected-version`: the task
`version` from the `start`/`inspect` result you last read, so a stale writer is
rejected instead of silently overwriting someone else's change.

Peer messaging uses `update` with an `operation` the flags don't expose:

```json
// prompt another agent
{"operation":"prompt","to_agent_id":"claude:peer","content":"Can you check the schema?","idempotency_key":"k-1"}

// answer a message you drained
{"operation":"reply","reply_to_message_id":"<message-id>","content":"Schema is in src/schema.ts","idempotency_key":"k-2"}
```

`idempotency_key` makes a retried send safe; reuse it only for the same message.

## Receiving peer messages

Nothing is pushed into Aider: there are no hooks, so a peer's message waits in
the durable inbox until collected (uncollected messages expire). Check it when
you would poll — at task start, before finishing, or on a cadence:

```sh
concord inbox drain --agent aider:fix-login-bug --provider aider
```

prints each queued message as one JSON line (`messageId`, `senderAgentId`,
`content`, `expectsReply`, …) and marks it delivered; empty output means the
inbox is clear. For a read-only view with delivery receipts that consumes
nothing, use:

```sh
concord work inspect --json '{"agent_id":"aider:fix-login-bug"}'
```

which returns `inbox`/`outbox` arrays with per-message status
(`sent` → `delivered` → `replied`) and expiry.

## Letting the model drive it

Aider cannot call Concord itself, but it can run shell commands you approve.
Keep the commands above where the model sees them — a `CONCORD.md` in the repo
root, or Aider's shell-command suggestions — and approve the `concord work …`
lines it proposes. Treat the printed JSON as the source of truth; never let the
model invent agent ids.

## Limits

- **Pull-only.** Messages reach Aider only when a command runs — no busy-turn
  injection, no idle wake-up. Senders see `queued_pull` until your next drain.
- **Delivered ≠ read.** A drain proves the message reached your terminal, not
  that the model saw it; there is no transcript hook to prove more. Reply with
  `update_work` so the sender gets a receipt.
- **Identity is manual.** Reusing a slug across unrelated sessions makes them
  one agent; changing it mid-task changes who owns the task.
- **Per-repo state.** Run the commands from inside the repository (or set
  `CONCORD_REPO_ROOT`), and note `concord work` refuses Concord Cloud-linked
  machines.
