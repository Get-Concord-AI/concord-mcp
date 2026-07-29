# Using Concord with Claude Code

## 1. Install

```bash
npm install -g @concord-ai/concord-mcp
```

## 2. Set up your repo

```bash
concord install
```

This does two things. It registers the MCP server in your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "concord": {
      "command": "concord-mcp"
    }
  }
}
```

And it writes a Concord block into `CLAUDE.md` telling the agent when to claim
work, share task context, and hand off. Both merge into whatever is already
there — other MCP servers and existing instructions are preserved — so it is
safe to re-run. Restart Claude Code afterwards so it picks up the server.

To manage `.mcp.json` yourself, pass `--no-mcp` and register Concord by hand
with the JSON above or:

```bash
claude mcp add concord -- concord-mcp
```

## 3. Use it

Ask Claude to start a task. It should call `claim_work` before editing,
`update_task` while working, and `get_task_context` when resuming or
coordinating. Assigned work must be accepted with its current version.
Ownership transfer uses `offer_handoff` and recipient acceptance/decline;
`handoff` records evidence only. Before a PR it calls `handoff` with
`ready_for_review` and the current `expected_version`. Check
progress with:

```bash
concord status
concord doctor   # shows per-task tool adoption
```

Generated `HANDOFF.md` and `REVIEW_PACKET.md` land in `.concord/`.
