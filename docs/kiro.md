# Kiro

Concord supports Kiro (IDE and CLI). Run `concord setup` in a repository and
Kiro gets the five Concord workflow tools, always-on steering, and lifecycle
hooks that register the session and deliver peer messages into a running turn.

Kiro can be detected from `kiro-cli` or `kiro` on `PATH`, an existing `~/.kiro`
directory, or a `.kiro` directory in the repository.

## What setup writes

| File                        | Purpose                                                                 |
| --------------------------- | ----------------------------------------------------------------------- |
| `.kiro/settings/mcp.json`   | Registers the `concord-mcp` stdio server with `CONCORD_AGENT_KIND=kiro` |
| `.kiro/steering/concord.md` | Concord workflow guidance, included with `inclusion: always`            |
| `.kiro/hooks/concord.json`  | Kiro v1 lifecycle hooks for identity and message delivery               |

All three are merged into existing content. Unrelated MCP servers, steering
files, hooks, and top-level hook settings are preserved, and re-running setup is
idempotent. An unreadable or malformed file is reported and left untouched.

With global mode on, the same files are managed at user level:
`~/.kiro/settings/mcp.json`, `~/.kiro/steering/concord.md`, and
`~/.kiro/hooks/concord.json`.

## Identity

Kiro passes a `session_id` to hooks on stdin but does not expose it to MCP
servers. Concord therefore derives `kiro:<hash>` in the `SessionStart` hook and
prints it as this session's `agent_id`. Pass that `agent_id` explicitly on
`start_work`, `update_work`, `transfer_work`, and `finish_work`. On
`inspect_work`, leave `agent_id` off unless you are reading your own inbox.

For a human-chosen name, set `CONCORD_AGENT_ID` before starting Kiro; it wins
over the derived id.

## Delivery

Kiro hooks fire on session start, user prompt submit, and turn end. Concord uses
them as follows:

- `SessionStart` registers presence and advertises the session as a pull
  endpoint.
- `UserPromptSubmit` drains pending messages and adds them to the prompt's
  context.
- `Stop` drains anything that arrived during the turn.

Kiro has no hook that wakes an idle session, so Concord reports Kiro as
`busy` reachable only. A message sent while a Kiro session is idle waits in the
durable inbox and arrives on the next prompt or turn end. Nothing polls, and no
background monitor is started.

To read the inbox manually from the repository:

```bash
concord inbox drain --agent <agent_id> --provider kiro
```

## Manual MCP registration

If you manage client configuration yourself, add this to
`.kiro/settings/mcp.json`:

```json
{
  "mcpServers": {
    "concord": {
      "command": "concord-mcp",
      "env": {
        "CONCORD_AGENT_KIND": "kiro"
      }
    }
  }
}
```

Concord's hook-based identity and delivery require the hooks file described
above; the MCP entry alone gives the tools but leaves messages in the durable
inbox until you drain them.

## Verified behavior

Kiro's documentation covers workspace and user MCP configuration, steering with
`inclusion: always`, and the v1 hooks format with `SessionStart`,
`UserPromptSubmit`, and `Stop` triggers:

- [MCP configuration](https://kiro.dev/docs/mcp/)
- [Steering](https://kiro.dev/docs/steering/)
- [Hooks](https://kiro.dev/docs/hooks/)

Runtime hook invocation was verified against Kiro CLI V3 and Kiro IDE hook
support. Older Kiro versions without hooks still get the MCP tools through the
manual registration above, but no automatic delivery.

If `concord adapters status` reports Kiro as `action_required`, check that
`.kiro/settings/mcp.json` parses and that `.kiro/hooks/concord.json` still
contains the three `concord-*` hooks. Restart Kiro after changing either file.

## Cloud-linked repositories

In a repository linked to Concord Cloud, Kiro hooks register and drain through
the cloud like every other harness. Nothing local is written for delivery; the
same busy-only `UserPromptSubmit`/`Stop` path applies.
