# Mistral Vibe

Concord supports the local Mistral Vibe CLI (verified on v3.1.3). Vibe has no
per-project Concord setup: registration is user-level, so one install covers
every repository Vibe opens.

Run `concord setup --global` (or `concord adapters install`) with Vibe on
`PATH`. Setup writes two files under `~/.vibe/` and preserves everything else
in them:

- `config.toml` gains a managed `[[mcp_servers]]` entry named `concord`
  (`transport = "stdio"`, `command = "concord-mcp"`,
  `CONCORD_AGENT_KIND=vibe` in its environment). Vibe spawns MCP children with
  a scrubbed environment, so the kind pin only guards against an inherited
  foreign session id.
- `hooks.toml` gains six `[[hooks]]` entries, one per lifecycle event:

| Vibe event      | Concord command                                                 | Purpose                                       |
| --------------- | --------------------------------------------------------------- | --------------------------------------------- |
| `session_start` | `concord hook vibe-session-start`                               | Register the session, print the `agent_id`    |
| `pre_agent`     | `concord inbox drain --from-hook --provider vibe --format vibe` | Deliver queued messages at turn start         |
| `post_tool`     | `concord inbox drain --from-hook --provider vibe --format vibe` | Deliver queued messages during the turn       |
| `post_agent`    | `concord inbox observe --provider vibe`                         | Read receipts, clear the wait-on-user flag    |
| `session_end`   | `concord hook vibe-session-end`                                 | Requeue unread deliveries, disconnect         |
| `notification`  | `concord inbox observe --provider vibe`                         | Approval/question notifications mark the wait |

Re-running setup is safe: only entries matching the shape Concord writes are
recognised and rewritten; user hooks, a hand-written `concord` MCP server, and
other `mcp_servers` entries are left untouched. `concord adapters uninstall`
removes only the Concord blocks. In global mode Concord also manages the
instruction block in `$VIBE_HOME/AGENTS.md` (`~/.vibe/AGENTS.md` by default),
which carries the peer-message trust guidance; disabling global mode removes
that block but leaves the adapter installed.

## Identity

Vibe passes its session id to hook commands on stdin (`session_id`) but does
not export it to MCP child processes, so the MCP server cannot derive the
agent on its own. Every hook payload resolves `vibe:<hash>` from that session
id — stable across `--resume`, and distinct for each spawned subagent, whose
payloads carry a non-null `parent_session_id`. Concord ignores subagent
payloads, so children never register or drain as independent peers.

Because the MCP side sees no session, the `session_start` hook prints the
session's `agent_id` as `hook_specific_output.additional_context` — Vibe's
only hook output channel that reaches the model. Pass that `agent_id` on
`start_work`, `update_work`, `transfer_work`, and `finish_work` calls.

## Delivery

Messages reach a Vibe session **while a turn runs**: `pre_agent` and
`post_tool` drain the inbox and return
`{"hook_specific_output": {"additional_context": …}}`, which Vibe injects
into the turn. `post_agent`, `notification`, `session_start`, and
`session_end` observe instead — they record read receipts (prompt text and
the session's `chunks/` history snapshots under `transcript_path`) and manage
queue state without injecting.

Vibe has **no verified idle wake-up channel**: `notification` hooks are
fire-and-forget and cannot start a turn. An idle Vibe session picks up
messages on its next turn. If a session needs a message sooner, copy the
`agent_id` from the session-start context and run
`concord inbox drain --agent <agent-id> --provider vibe` from the repository.

## Verified behavior

Checked against Vibe 3.1.3 on Windows:

- `[[mcp_servers]]` stdio entries in `~/.vibe/config.toml` accept `name`,
  `transport`, `command`, `args`, `env`, and `cwd`; the schema requires
  `name`, `transport`, and `command`.
- `~/.vibe/hooks.toml` and project `.vibe/hooks.toml` both load; hook payloads
  carry `session_id`, `transcript_path` (a session directory whose `chunks/`
  snapshots hold the conversation), `cwd`, `parent_session_id`, `source`,
  `prompt`, `turn_id`, `response_text`, `reason`, `agent_name`, and `model`.
- `hook_specific_output.additional_context` on stdout is the only hook output
  Vibe forwards to the model; plain stdout is ignored.
- The session id is stable across `--resume`; subagent payloads carry a
  non-null `parent_session_id`.
- Headless runs (`vibe -p`) invoke the same hooks.

## Limitations

- Busy-turn delivery only; no idle wake-up until Vibe grows a channel that
  can start a turn.
- Concord writes user-level config only. To scope registration to one
  repository, add the same `[[mcp_servers]]` and `[[hooks]]` blocks to that
  project's `.vibe/config.toml` and `.vibe/hooks.toml` by hand.
- `concord setup` in a repository does not write project `.vibe/` files;
  Vibe's user-level files are the supported path.
