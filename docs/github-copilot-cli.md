# Using Concord with GitHub Copilot CLI

Run `concord setup` in the repository. When `copilot` (1.0 or later) is on
`PATH`, setup installs Concord's Copilot CLI adapter:

- registers Concord's MCP server in Copilot's user config
  (`~/.copilot/mcp-config.json`);
- installs Concord's lifecycle hooks in `~/.copilot/hooks/concord.json`;
- registers the server in the workspace config `.github/mcp.json` and writes a
  Concord block into `.github/copilot-instructions.md`.

Existing servers, settings, env, and instructions are preserved, so re-running
is safe. Restart existing Copilot CLI sessions afterwards so they reload MCP
config and hooks.

## Identity

Copilot CLI hands its MCP servers `COPILOT_AGENT_SESSION_ID`, and passes the
same id to hooks as `sessionId`. Concord derives one agent id from it,
`copilot-cli:<hash>`, so Copilot's work is attributed to its own session
without the model passing an `agent_id`. The session-start hook tells the
session its id and who else is in the workspace.

The user-level server entry pins only `CONCORD_AGENT_KIND=copilot-cli`, never a
repository: Copilot starts MCP servers in the project directory, so each
repository resolves its own workspace.

## Messages

Start Copilot through Concord to make the session reachable while it is idle:

```bash
concord adapters copilot            # instead of `copilot`
concord adapters copilot -i "..."   # any Copilot flags are forwarded
```

The launcher runs Copilot's TUI with its embedded server (`--ui-server`) on a
fresh loopback port. When the session starts, Concord's hook launches a host
for it that resumes the session over that server and hands each message to
Copilot: it steers a running turn, or starts a new turn while Copilot is idle
— the same shape as `concord adapters codex`. The host exits with the TUI.
Copilot releases before 1.0.100 are started without the server and keep hook
delivery.

Sessions started with plain `copilot` use hooks only:

| Hook           | What Concord does                                                    |
| -------------- | -------------------------------------------------------------------- |
| `sessionStart` | registers the session and advertises it as reachable                 |
| `postToolUse`  | delivers waiting messages into the turn after each tool call         |
| `agentStop`    | keeps the turn going when a message arrived after the last tool call |

A message sent to an idle plain session waits in its inbox and arrives during
its next turn.

> **Security:** like Codex's app-server, Copilot's embedded server listens on
> `127.0.0.1` without authentication, so other processes and users on the same
> machine can reach it while the session runs. Use plain `copilot` on shared
> machines.

Copilot also runs hooks from a project's `.claude/settings.json`. Concord's
optional Claude Code session-start hook stays silent inside Copilot, so it
never registers a second, Claude-kind agent for the same session.

## Configuration

`COPILOT_HOME` moves both the MCP config and the hooks directory. The entries
Concord writes look like:

```json
{
  "mcpServers": {
    "concord": {
      "type": "local",
      "command": "concord-mcp",
      "args": [],
      "env": { "CONCORD_AGENT_KIND": "copilot-cli" },
      "tools": ["*"]
    }
  }
}
```

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [
      { "type": "command", "bash": "concord hook session-start --client copilot-cli" }
    ],
    "postToolUse": [
      { "type": "command", "bash": "concord hook post-tool-use --client copilot-cli" }
    ],
    "agentStop": [{ "type": "command", "bash": "concord hook stop --client copilot-cli" }]
  }
}
```

On a machine linked to Concord Cloud, the hooks register and deliver through
the cloud instead of the local database.

Validate installation with:

```bash
concord adapters doctor
copilot mcp list
```

> **Note:** If `mcp-config.json` is not valid JSON, setup leaves the file
> untouched and asks you to fix or remove it first, rather than overwriting a
> hand-written config. `concord adapters uninstall` removes Concord's server
> entry and hooks file and nothing else.
