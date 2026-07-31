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

With the live-prompt integration approved by `concord setup --agent-comms`,
another workspace agent can address this Claude session through `update_work`.
The managed-session adapter pushes streaming input into a busy turn and starts
a turn while idle; existing sessions need one restart after installation.
