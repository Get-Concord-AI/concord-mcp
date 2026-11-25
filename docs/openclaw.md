# OpenClaw

Run `concord setup` from the repository you want to coordinate. Setup detects
the OpenClaw CLI or state directory and registers Concord in `mcp.servers.concord`.
It reads `$OPENCLAW_CONFIG_PATH` when set, otherwise `openclaw.json` in the
OpenClaw state directory for the current profile. It preserves existing settings and
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

Run `concord setup --global` to add identity instructions to each agent's
workspace. Concord uses `openclaw agents list --json` to find the workspaces
OpenClaw actually uses. Give each agent a separate workspace for automatic
identity instructions. `concord setup --no-global` removes the managed blocks.

Give every OpenClaw agent its own stable Concord ID. In its workspace
`AGENTS.md`, tell it to pass `agent_id: "openclaw:<id>"` on workflow writes,
where `<id>` is its OpenClaw agent ID (`main` by default). On `start_work`, use
`kind: "openclaw"`. To acknowledge and print waiting messages on demand, run
`concord inbox drain --provider openclaw --agent openclaw:<id>` from the project.
`inspect_work` with the agent ID can display the inbox.

If the gateway starts Concord outside the repository, pass `workspace_id`.
For local Concord, use the workspace ID printed by `concord setup` in that
repository. For Concord Cloud, use the repository's Git remote.

Use `concord adapters uninstall` to remove Concord-managed registrations,
including OpenClaw's.
