# Using Concord with Claude Code

## 1. Install

```bash
npm install -g @concord-ai/concord-mcp
```

## 2. Set up your repo

```bash
concord setup
```

This creates `.concord/` and registers the MCP server in your project's
`.mcp.json`:

```json
{
  "mcpServers": {
    "concord": {
      "command": "concord-mcp",
      "env": {
        "CONCORD_REPO_ROOT": "/absolute/path/to/this/repository"
      }
    }
  }
}
```

It also writes a Concord block into `CLAUDE.md` telling the agent when to claim
work, share task context, and hand off. Both merge into whatever is already
there — other MCP servers and existing instructions are preserved — so it is
safe to re-run. Restart Claude Code afterwards so it picks up the server.

To manage `.mcp.json` yourself, pass `--no-mcp` and register Concord by hand
with the JSON above or:

```bash
claude mcp add concord -- concord-mcp
```

## 3. Use it

Ask Claude to start a task. It should call `start_work` before editing,
`update_work` while working, and `inspect_work` when resuming or coordinating.
Assignments and handoffs use `transfer_work` with the task's current version.
Before a PR it calls `finish_work` with `outcome: "review_ready"`, evidence, and
the current `expected_version`. Check progress with:

```bash
concord status
concord doctor   # shows per-task tool adoption
```

Generated `HANDOFF.md` and `REVIEW_PACKET.md` land in `.concord/`.

`concord setup` installs the global `concord-relay` plugin. Its native monitor
polls for the lifetime of an interactive session, so a line of output wakes an
idle Claude session; PostToolUse and Stop hooks cover messages received while a
turn is active or ending. Existing sessions need one restart after installation.

Apps that drive Claude Code through the Claude Agent SDK, such as
[Conductor](./conductor.md), never start plugin monitors. For those sessions
(`CLAUDE_CODE_ENTRYPOINT` is `sdk-ts` or `sdk-py`), the plugin's Stop hook arms
`concord inbox rewake`, an `asyncRewake` hook. It waits for the next message
and exits with code 2, which wakes the idle session with it. In interactive
sessions the same hook stays quiet while the plugin monitor is alive; it only
waits when no monitor is beating, covering the gap below.

Claude Code holds a monitor notification while the agent is blocked on its user
(an `AskUserQuestion` picker or a permission prompt), so a message the monitor
drained is `delivered` (✓✓) but not yet `read`. It becomes read only on
evidence naming its id: the prompt that starts a turn with the notification
(UserPromptSubmit), or the session transcript showing the message followed by
model output (checked at PostToolUse and Stop). A turn merely ending proves
nothing. A reply also counts as read. If the session ends first, its unread
messages go back to sent (SessionEnd), and a fresh session for the same agent
(`CONCORD_AGENT_ID`) receives them again on startup. `claude --resume`
restores the held notification instead, so it is not resent.

The same hooks record when a session stops to wait on its user. `concord status`
and `inspect_work` show it, and a sender's outlook warns that the message will
not be read until the user responds. Dismissing a prompt with Esc or Deny fires
no hook, so the flag clears at the session's next prompt, tool call, or turn
end; it is advisory and never holds delivery.

## Troubleshooting: messages stop arriving after `claude --resume`

Claude Code can fail to re-arm a plugin monitor within the same process —
upstream bug [anthropics/claude-code#111286](https://github.com/anthropics/claude-code/issues/111286).
The monitor that was running keeps its old session identity, and no replacement
starts, so an idle resumed session used to hear nothing.

Concord works around both halves of that:

- **Identity.** Every SessionStart hook records which agent the client now
  hosts (`session_bindings`). The monitor consults it on each poll, so a
  monitor that survives a `/resume` or `/clear` keeps draining the _live_
  session's inbox instead of the abandoned one. On a machine linked to
  Concord Cloud (`concord cloud link`), identity stays environment-based —
  session bindings are local — so this correction does not apply there.
- **Reachability.** While no receiver heartbeat is live, the Stop hook's
  `asyncRewake` waiter steps in and wakes the idle session with the next
  message, then stands down once a monitor is back. A monitor that exits
  cleanly drops its heartbeat at once (`concord inbox release`), so the
  fallback can arm without waiting out the lease; only a killed monitor
  leaves it to expire on its own (~10s).

One gap remains: a session that lands at the prompt right after a `/resume`
with no live monitor gets no waiter until its first turn ends — SessionStart
only registers and observes, and the fallback arms at Stop. A message sent in
that window waits for the user's first turn (or a manual
`concord inbox drain --provider claude-code`).

If messages still do not arrive, check `concord inbox status` from the repo:
a workspace that is not Concord-enabled exits the monitor silently by design.
