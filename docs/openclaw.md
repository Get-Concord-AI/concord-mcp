# Using Concord with OpenClaw

Run `concord setup` in the repository. Setup registers Concord's MCP server in
OpenClaw's `openclaw.json` when OpenClaw is detected: either the `openclaw` CLI
is on `PATH`, or its state directory exists (the Gateway often runs as a service
on a machine where the CLI is not on the shell's `PATH`). The server is added
under `mcp.servers.concord` and preserves every other server and setting.

OpenClaw starts a fresh set of stdio MCP servers for each session, without
telling them which session or agent is calling. Concord therefore cannot derive
an OpenClaw session identity the way it does for Claude Code or Goose, and does
not verify idle wake-up. Delivery is pull-only: agents read their inbox during
their own turns. Identity comes from the instructions written into each agent's
workspace (see below).

## Configuration

Concord is written to OpenClaw's standard config file:

- `~/.openclaw/openclaw.json`, or
- `$OPENCLAW_CONFIG_PATH` when set; the state directory itself follows
  `$OPENCLAW_STATE_DIR`.

The entry added looks like:

```json5
{
  mcp: {
    servers: {
      concord: {
        command: 'npx',
        args: ['-y', '@concord-ai/concord-mcp'],
        env: { CONCORD_AGENT_KIND: 'openclaw' },
        enabled: true,
      },
    },
  },
}
```

A standalone Concord install points `command` at its own `concord-mcp` launcher
instead of `npx`. An entry named `concord` that Concord did not write is left
alone, on install and on uninstall.

> **Note:** OpenClaw's config is JSON5. Concord reads it as JSON5 but rewrites
> it as plain JSON, so comments in the file are not preserved. Run
> `openclaw mcp doctor concord --probe` to check that OpenClaw can start the
> server after setup.

## Agent identity

With global mode on, Concord adds its block to the `AGENTS.md` of every
configured OpenClaw agent's workspace (`agents.defaults.workspace`,
`agents.entries.<id>.workspace`, or OpenClaw's defaults under the state
directory). Each block names that agent's stable Concord id, `openclaw:<agentId>`,
and tells the agent to pass it as `agent_id` on every Concord tool call. Several
OpenClaw agents on one machine therefore keep separate presence and claims.
Turning global mode off removes only Concord's blocks and the entry it wrote.

To name an agent yourself, set `CONCORD_AGENT_ID` in the server's `env` in
`openclaw.json`; an operator-set id always wins over a supplied one.
