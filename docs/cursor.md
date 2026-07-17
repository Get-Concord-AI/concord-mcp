# Using Concord with Cursor

## 1. Install

```bash
npm install -g get-concord-mcp
```

## 2. Register the MCP server

Add Concord to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "concord": {
      "command": "get-concord-mcp"
    }
  }
}
```

## 3. Install the agent instructions

```bash
concord install
```

This writes `.cursor/rules/concord.mdc` (with `alwaysApply: true`) so the agent
knows when to call `claim_work`, `handoff`, and `review_ready`. It is idempotent.

## 4. Use it

Track progress and artifacts from the terminal:

```bash
concord status
concord doctor
cat .concord/REVIEW_PACKET.md
```
