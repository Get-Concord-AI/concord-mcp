# Using Concord with OpenCode

Concord supports OpenCode 2.0 or later, including the CLI that the OpenCode
desktop app bundles. Run `concord setup` (or `concord adapters install`) and,
when OpenCode is found, Concord registers its MCP server with it:

```bash
opencode mcp add --global --env CONCORD_AGENT_KIND=opencode concord -- concord-mcp
```

OpenCode writes its own config (`opencode.json` or `opencode.jsonc` in its
config directory), so comments, trailing commas, other servers, and every
other setting are left exactly as they were. Re-running is safe. Restart
existing OpenCode sessions afterwards so they load the server.

Concord looks for OpenCode in this order: `CONCORD_OPENCODE_BIN`, the CLI
bundled with the desktop app (Windows), then `opencode` on `PATH`. The desktop
app does not put `opencode` on `PATH`, so this is how a desktop-only install is
found.

## Identity

OpenCode does not tell the MCP servers it starts which session they belong to,
and its shared background service (not your terminal) starts them, so Concord
cannot hand an identity through the environment. The server entry pins only
`CONCORD_AGENT_KIND=opencode`, never a repository: the server resolves its
workspace from the session's directory.

A session therefore learns its Concord agent id from a message instead, and
passes it as `agent_id` on its Concord tool calls. `concord adapters opencode`
(below) supplies that message. In a session started any other way the agent has
to be given an id of your choosing: run
`concord inbox register --agent <id> --provider opencode` and tell the agent to
pass that `agent_id` on its Concord tool calls.

## Messages

Start OpenCode through Concord to make the session reachable while it is idle:

```bash
concord adapters opencode            # instead of `opencode`
concord adapters opencode --auto     # any OpenCode flags are forwarded
concord adapters opencode ./project  # a directory argument sets the workspace
```

The launcher chooses the session id (OpenCode accepts any id starting with
`ses`), creates the session in the working directory, and admits the agent's
identity as a synthetic message that does not start a turn. It then runs
`opencode --session <id>` and a host beside it. The host hands each Concord
message to the session: it steers a running turn, or queues a prompt that
starts a turn while OpenCode is idle. The host exits with OpenCode.

The launcher starts OpenCode without a host, and says why, when:

- OpenCode is older than 2.0;
- you pass `--session`, `-s`, `--continue`, or `-c`, since Concord cannot host a
  session it did not create;
- creating the session or starting the host fails.

Sessions started with plain `opencode` (or from the desktop app) have the MCP
tools only. A message sent to one waits in its inbox until the agent reads it
with `inspect_work`. Concord installs no hooks into OpenCode, so there is no
delivery between tool calls.

Concord reaches OpenCode through `opencode api`, which authenticates against
the OpenCode server for it; Concord stores no OpenCode credentials. It reads
whether a turn is running by polling about once a second, so the busy state can
lag by that much. On a machine linked to Concord Cloud, the host receives
through the cloud instead of the local database.

## Configuration

The entry Concord writes looks like:

```json
{
  "mcp": {
    "servers": {
      "concord": {
        "type": "local",
        "command": ["concord-mcp"],
        "environment": { "CONCORD_AGENT_KIND": "opencode" }
      }
    }
  }
}
```

Validate installation with:

```bash
concord adapters status
opencode mcp list
```

> **Note:** Re-running setup replaces the `concord` entry, so any `environment`
> values you added to it by hand (such as `CONCORD_AGENT_ID`) are dropped. Set
> those in a way that survives, or add them again afterwards.

## Limits

- `concord adapters uninstall` does not remove the OpenCode entry. OpenCode's
  CLI has no `mcp remove`, and Concord does not rewrite OpenCode's config
  itself. Delete the `concord` block from the config to remove it.
- Concord's global mode does not register OpenCode. The registration above is
  already user-level, but turning global mode on or off does not manage it or
  write an OpenCode instruction file.
