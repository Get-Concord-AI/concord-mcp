# OpenClaw

Run `concord setup` from the repository you want to coordinate. Setup detects
the OpenClaw CLI or state directory and registers Concord in `mcp.servers.concord`.
It reads `$OPENCLAW_CONFIG_PATH` when set, otherwise `openclaw.json` under
`$OPENCLAW_STATE_DIR` or `~/.openclaw`. It preserves existing settings and
custom Concord entries. A config change rewrites JSON5 as JSON and drops comments.

Run `openclaw mcp reload` or restart the gateway, then verify the connection
with `openclaw mcp probe concord`. Run `concord doctor` for adapter diagnostics.
For MCP config managed through `$include`, register the server in the file
that defines `mcp.servers`, using this entry for an npm install:

```json
{
  "command": "npx",
  "args": ["-y", "@concord-ai/concord-mcp"],
  "env": { "CONCORD_AGENT_KIND": "openclaw" },
  "enabled": true
}
```

## Agent identity and delivery

Give every OpenClaw agent its own stable Concord ID. In its workspace
`AGENTS.md`, tell it to pass `agent_id: "openclaw:<id>"` on workflow writes,
where `<id>` is its OpenClaw agent ID (`main` by default). On `start_work`, use
`kind: "openclaw"`. To read that agent's inbox, call `inspect_work` with its
`agent_id`. Messages are pulled during turns.

Use `workspace_id` to identify the repository if the gateway starts Concord
outside it. On a machine signed in to Concord Cloud, use the repository's
remote as the workspace ID.

Use `concord adapters uninstall --yes` to remove Concord-managed registrations,
including OpenClaw's.
