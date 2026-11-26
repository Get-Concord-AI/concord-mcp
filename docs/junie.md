# Using Concord with Junie

Run `concord setup` in the repository. Setup registers Concord's MCP server in
Junie's `~/.junie/mcp/mcp.json` and installs lifecycle hooks in
`~/.junie/config.json` when `junie` is detected on PATH.

Junie CLI supports lifecycle hooks (`SessionStart`, `UserPromptSubmit`,
`SessionEnd`) configured in `~/.junie/config.json`. Concord registers three
hooks that automatically handle session registration, identity delivery, and
peer message delivery — no manual polling is needed.

Lifecycle hooks are a Junie Early Access feature. Concord verified this setup
against Junie 26.11.0 and uses it as the minimum baseline; JetBrains does not
publish a hooks-specific version floor, so older releases may work but are not
covered.

## Configuration

### MCP Server

Concord is written to the standard Junie MCP config file:

- **Path**: `~/.junie/mcp/mcp.json`

`concord setup` also writes a project-scoped `.junie/mcp/mcp.json` in the
repository, so sessions opened inside the project pick Concord up even without
the global file.

The entry added looks like:

```json
{
  "mcpServers": {
    "concord": {
      "command": "concord-mcp",
      "env": {
        "CONCORD_AGENT_KIND": "junie"
      }
    }
  }
}
```

If `JUNIE_HOME` is set, these files live under it instead of `~/.junie`.

### Lifecycle Hooks

Concord registers hooks in `~/.junie/config.json`:

- **Path**: `~/.junie/config.json`

The hooks added are:

- `SessionStart` → `concord hook junie-session-start` — registers session
  identity and presence before work begins
- `UserPromptSubmit` → `concord hook junie-user-prompt-submit` — delivers the
  identity briefing on the session's first prompt (see below) and drains
  pending peer messages before each user prompt
- `SessionEnd` → `concord hook junie-session-end` — fires when the session
  finishes (see the limitation below for what it can and cannot clean up)

## How the identity reaches the model

Junie's own hook limitations document that `SessionStart` **ignores
`additionalContext`** — the one channel hooks have for reaching the model —
and the `async` field cannot change that, since `SessionStart` already runs
in the background at the executor level. So although the SessionStart hook
registers the session (and could compose its briefing), Junie would drop that
output: the model would never learn its `agent_id`, and `start_work` without
one would fail.

Concord therefore delivers the identity briefing through the first
`UserPromptSubmit` of the session instead — the hook event whose context
always reaches the model. The briefing is prepended to whatever peer messages
the same drain returns, and a per-session marker (keyed by the agent id in
the machine temp dir) guarantees it is delivered exactly once: resuming a
session does not repeat it, while a `/clear` or fresh session — a new session
id — briefs again. If you script Junie non-interactively, note the ACP caveat
below: with no `UserPromptSubmit` at all, the briefing never lands, so pass
`agent_id` explicitly or export `CONCORD_AGENT_ID` before launching.

Known limitation: Junie's `SessionEnd` payload carries only `reason`, not
`session_id`, so the hook cannot tell which session ended and the pull endpoint
is not disconnected right away. The endpoint's presence still lapses through
`last_seen`, and a later `SessionStart` for the same session re-registers it.

Junie fires `UserPromptSubmit` only in the interactive TUI. ACP hosts invoke
`SessionStart`, `PreToolUse` and `SessionEnd` but never `UserPromptSubmit`, so
non-interactive/ACP sessions get no prompt-time message drain — they still
register on `SessionStart` and can pull with `concord inbox drain`.

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
   session identity with Concord, and your first prompt carries the identity
   briefing to the model (see _How the identity reaches the model_).
3. Before each user prompt, the `UserPromptSubmit` hook drains any pending peer
   messages from other agents.
4. Use the five Concord workflow tools (`start_work`, `inspect_work`,
   `update_work`, `transfer_work`, `finish_work`) via MCP as normal.
5. Run `concord doctor` to verify the adapter status.
