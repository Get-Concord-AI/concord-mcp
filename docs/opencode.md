# Using Concord with OpenCode

Run `concord setup` in the repository. Setup registers Concord's MCP server in
the project `opencode.json` — it writes the config whether or not OpenCode is
currently installed, so a fresh clone is ready the moment you run OpenCode —
and writes a Concord block into `AGENTS.md`, which OpenCode loads automatically
from the repo root, telling the agent when to claim work, share task context,
and hand off. Then start an OpenCode session so it reloads the MCP config.

OpenCode is an MCP-capable agent with no verified session wake or resume
mechanism and no lifecycle hooks. Concord delivers messages as durable inbox
entries the agent drains on its next tool call or turn; there is no way to wake
an idle session, so `concord adapters status` reports OpenCode with pull and
busy reach only. Do not expect an idle OpenCode session to answer a
`send_agent_message` — the sender is told the message is queued.

## Configuration

Setup writes to the project config file — `opencode.json`, or `opencode.jsonc`
when only that exists. `OPENCODE_CONFIG` wins over both when set. OpenCode reads
`~/.config/opencode/opencode.json` as well and **merges** it with the project
file rather than replacing it, so a global config is a fallback, not a conflict.

The entry uses OpenCode's own server shape, which differs from the shared
`mcpServers` form other harnesses use — note `type: "local"` and the array
`command`:

```json
{
  "mcp": {
    "concord": {
      "type": "local",
      "command": ["concord-mcp"],
      "environment": {
        "CONCORD_REPO_ROOT": "/absolute/path/to/this/repository",
        "CONCORD_AGENT_KIND": "opencode"
      },
      "enabled": true
    }
  }
}
```

Every other server and every unrelated top-level key is preserved, the file is
rewritten as plain JSON, and re-running is a no-op. Pass `--no-mcp` to write
only the instructions and add the entry above by hand.

## Identity

OpenCode spawns MCP servers with the full inherited environment but exposes no
stable session id to them (only `OPENCODE=1` and `OPENCODE_PID`), so Concord
cannot auto-derive which session is calling. Two options, in order of
preference:

- Set `CONCORD_AGENT_ID` before launching OpenCode. This also lets you name
  agents by hand (`alpha`, `reviewer`) instead of a generated slug.
- Otherwise run `concord inbox register` in a terminal and pass the printed
  `agent_id` on each tool call.

Without either, tool calls fail with Concord's unresolved-identity message.

## Use it

Ask OpenCode to start a task. It should call `start_work` before editing,
`update_work` while working, and `inspect_work` when resuming or coordinating.
Assignments and handoffs use `transfer_work` with the task's current version.
Before a PR it calls `finish_work` with `outcome: "review_ready"` and the
evidence needed for review. Generated `HANDOFF.md` and `REVIEW_PACKET.md` land
in `.concord/`.

Track it from your terminal:

```bash
concord status
concord doctor
concord adapters doctor   # reports OpenCode's pull/busy capabilities
opencode mcp list         # shows the configured server
```

Verified against OpenCode 1.19.0: a real session called `start_work` and
`inspect_work` and returned the correct `workspace_id`. Refer to the current
[OpenCode MCP documentation](https://opencode.ai/docs/mcp-servers/) if the
config format changes.
