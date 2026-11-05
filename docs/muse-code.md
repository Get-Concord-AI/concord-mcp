# Using Concord with Muse Code

Meta's Muse Code is a terminal coding agent built on the Muse Spark model (macOS and Linux). Concord integrates with Muse Code via its stdio MCP server configuration and repository instruction files.

## 1. Setup

### Automatic setup (Global mode / Adapters)

When `muse` is installed on your `PATH`:

- **Machine-wide setup (server + instructions)**: Run `concord setup --global` to register the MCP server in `~/.config/muse/settings.json` and install instructions into `~/.config/muse/AGENTS.md`.
- **MCP server registration only**: Run `concord adapters install` to register Concord in `~/.config/muse/settings.json` without writing global instructions.

### Repository instructions

When you run `concord setup` inside a repository, Concord writes workflow instructions to `AGENTS.md` in the repository root. Muse Code automatically loads `AGENTS.md` when launching in a trusted workspace.

### Configuration file

Muse Code reads user settings from:

- **Linux / macOS**: `~/.config/muse/settings.json` (or `$XDG_CONFIG_HOME/muse/settings.json`)

Concord registers itself under the `mcp_servers` object while preserving all existing user settings and schema properties:

```json
{
  "schema_version": 1,
  "mcp_servers": {
    "concord": {
      "command": "concord-mcp"
    }
  }
}
```

> **Note:** Muse Code requires `"schema_version": 1` in `settings.json`. Concord preserves existing schema versions or initializes the property when creating a new settings file.

## 2. Agent identity and constraints

- **Session identity**: Muse Code automatically injects `MUSE_SESSION_ID` into the environment of spawned stdio MCP servers. Concord derives the agent identity (`muse-code:<hash>`) from this variable.
- **Subagent limitation (Follow-up)**: Muse Code shares the MCP server process between the top-level session and child subagents, providing `MUSE_SESSION_ID` to MCP servers while exposing `MUSE_THREAD_ID` only to hooks. Because Concord derives session identity directly from the MCP environment, distinct per-subagent identities cannot be assigned at this time. All subagents in a session coordinate under the primary session identity.
- **Relay hooks (Follow-up)**: Live inbox message delivery and relay hooks are deferred until upstream Muse Code supports associating MCP tool calls with child thread IDs.

## 3. Diagnostics and verification

Verify your setup with:

```bash
concord adapters status
concord doctor
```

When `muse` is on your `PATH` and `settings.json` contains Concord's `mcp_servers` entry, `concord adapters status` reports Muse Code as `installed`.
