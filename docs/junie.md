# Using Concord with Junie

Run `concord setup` in the repository. Setup registers Concord's MCP server in
Junie's `~/.junie/mcp/mcp.json` and installs lifecycle hooks in
`~/.junie/config.json` when `junie` is detected on PATH.

Junie CLI supports lifecycle hooks (`SessionStart`, `UserPromptSubmit`,
`SessionEnd`) configured in `~/.junie/config.json`. Concord registers three
hooks that automatically handle session identity, peer message delivery, and
session cleanup — no manual polling is needed.

## Configuration

### MCP Server

Concord is written to the standard Junie MCP config file:

- **Path**: `~/.junie/mcp/mcp.json`

The entry added looks like:

```json
{
  "mcpServers": {
    "concord": {
      "command": "concord-mcp"
    }
  }
}
```

### Lifecycle Hooks

Concord registers hooks in `~/.junie/config.json`:

- **Path**: `~/.junie/config.json`

The hooks added are:

- `SessionStart` → `concord hook junie-session-start` — registers session
  identity and presence before work begins
- `UserPromptSubmit` → `concord hook junie-user-prompt-submit` — drains pending
  peer messages before each user prompt
- `SessionEnd` → `concord hook junie-session-end` — cleans up endpoints when
  the session finishes

The config looks like:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "concord hook junie-session-start" }]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "concord hook junie-user-prompt-submit"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "concord hook junie-session-end" }]
      }
    ]
  }
}
```

## Workflow

1. Run `concord setup` to register the MCP server and lifecycle hooks.
2. Start a Junie session — the `SessionStart` hook automatically registers your
   session identity with Concord.
3. Before each user prompt, the `UserPromptSubmit` hook drains any pending peer
   messages from other agents.
4. Use the five Concord workflow tools (`start_work`, `inspect_work`,
   `update_work`, `transfer_work`, `finish_work`) via MCP as normal.
5. Run `concord doctor` to verify the adapter status.
