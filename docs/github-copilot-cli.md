# Using Concord with GitHub Copilot CLI

Run `concord setup` in the repository. Setup registers Concord's MCP server in
Copilot CLI's user config (`~/.copilot/mcp-config.json`) and in the workspace
config (`.github/mcp.json`), and writes a Concord block into
`.github/copilot-instructions.md` so the agent knows when to claim work, share
task context, and hand off. Existing servers, settings, and instructions are
preserved, so re-running is safe. Restart existing Copilot CLI sessions
afterwards so they reload MCP config.

Copilot CLI exposes no hooks and no session id to spawned MCP servers, so
Concord cannot derive a session identity and cannot wake or steer a session.
Messaging is durable inbox delivery only: senders queue messages and the
receiving agent pulls them with its inbox tool on a later turn. Supply the
agent id per tool call, or set `CONCORD_AGENT_ID` before launch, so Concord
knows which Copilot session is which. `concord adapters status` reports Copilot
CLI with pull plus busy reach only — there is no idle delivery path.

## Configuration

Concord is written to Copilot CLI's user-scoped MCP config:

- **Windows**: `%APPDATA%\copilot\mcp-config.json`
- **Unix**: `~/.copilot/mcp-config.json`
- **Anywhere**: `$COPILOT_HOME/mcp-config.json` when `COPILOT_HOME` is set

The entry added looks like:

```json
{
  "mcpServers": {
    "concord": {
      "type": "local",
      "command": "concord-mcp",
      "args": [],
      "env": {
        "CONCORD_REPO_ROOT": "/absolute/path/to/this/repository",
        "CONCORD_AGENT_KIND": "copilot-cli"
      },
      "tools": ["*"]
    }
  }
}
```

Setup also registers Concord in the workspace config `.github/mcp.json`
using the same `mcpServers` shape. The instructions file
is `.github/copilot-instructions.md`; `copilot init` generates it and
`copilot instruction list` shows which instruction sources are in play.

The same entries can be managed from the CLI with
`copilot mcp add/remove/enable/disable/list/get`, and `copilot mcp list` shows
what a session will load. Validate installation with:

```bash
concord adapters doctor
copilot --version
copilot mcp list
```

> **Note:** If `mcp-config.json` is not valid JSON, setup leaves the file
> untouched and asks you to fix or remove it first, rather than overwriting a
> hand-written config.
