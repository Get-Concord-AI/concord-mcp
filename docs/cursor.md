# Using Concord with Cursor

## 1. Install

```bash
npm install -g @concord-ai/concord-mcp
```

## 2. Set up your repo

```bash
concord install
```

This registers the MCP server in `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "concord": {
      "command": "concord-mcp"
    }
  }
}
```

and writes `.cursor/rules/concord.mdc` (with `alwaysApply: true`) so the agent
knows when to claim work, share task context, and hand off. Existing servers and
rules are preserved and it is idempotent. Restart Cursor afterwards so it picks
up the server. Pass `--no-mcp` to write only the rule and register Concord
yourself with the JSON above.

The one-click deeplink in the README registers Concord through `npx` instead,
for trying it without a global install.

## 3. Use it

Track progress and artifacts from the terminal:

```bash
concord status
concord doctor
cat .concord/REVIEW_PACKET.md
```
