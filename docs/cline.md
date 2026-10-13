# Using Concord with Cline

Run `concord setup` in the repository. When `cline` 1.0.0 or newer is on `PATH`,
setup merges Concord into Cline's MCP settings without touching other servers,
and writes `.cline/rules/concord.md`. Restart Cline afterwards.

The settings file is `CLINE_MCP_SETTINGS_PATH`, or
`$CLINE_DATA_DIR/settings/cline_mcp_settings.json`, or
`~/.cline/data/settings/cline_mcp_settings.json`. The CLI and the IDE share it.
Concord pins `CONCORD_REPO_ROOT` to this repository and `CONCORD_AGENT_KIND` to
`cline`. Re-running setup here is byte-identical. Setup in another repository
retargets the pin; other servers and env vars you added stay. Invalid JSON is
left untouched. `--no-mcp` writes only the rule. The server entry is
`mcpServers.concord` with `command: "concord-mcp"`, `args: []`, `disabled: false`,
and those two env vars.

Cline does not export a session id to its MCP process, so Concord will not
invent one. Set `CONCORD_AGENT_ID`, or point a `TaskStart`/`TaskResume` hook at
`concord inbox register --from-hook --provider cline` (the payload's `taskId`
becomes `cline:<hash>`). Otherwise pass the id from `concord inbox register`.
`cline --id` and `TaskResume` do not wake an idle session, so Concord advertises
pull and busy only. Messages wait until the next turn. `concord adapters status` reports it.
