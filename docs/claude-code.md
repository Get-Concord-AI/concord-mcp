# Using Concord with Claude Code

## 1. Install

```bash
npm install -g @concord-ai/concord-mcp
```

## 2. Register the MCP server

Add Concord to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "concord": {
      "command": "concord-mcp"
    }
  }
}
```

Or use the Claude Code CLI:

```bash
claude mcp add concord -- concord-mcp
```

## 3. Install the agent instructions

```bash
concord install
```

This writes a Concord block into `CLAUDE.md` telling the agent when to claim
work, share task context, and hand off. It preserves any existing content and is
safe to re-run.

## 4. Use it

Ask Claude to start a task. It should call `claim_work` before editing,
`update_task` while working, and `get_task_context` when resuming or
coordinating. Before a PR it calls `handoff` with `ready_for_review`. Check
progress with:

```bash
concord status
concord doctor   # shows per-task tool adoption
```

Generated `HANDOFF.md` and `REVIEW_PACKET.md` land in `.concord/`.
