# Cline

Concord supports Cline — the CLI (`cline`), the VS Code extension, and
JetBrains surfaces, which all share one configuration. Run `concord setup` in
a repository and Cline gets the five Concord workflow tools, always-on rules,
and global lifecycle hooks that register each task and deliver peer messages
into a running turn.

Cline is detected from `cline` on `PATH`, an existing `~/.cline` or
`~/Documents/Cline` directory, or a VS Code-family extension install
(`saoudrizwan.claude-dev` in `globalStorage`), including an extension that has
never run far enough to create `~/.cline`.

## What setup writes

Cline has **one global MCP settings file** shared by every project — there is
no project-scoped MCP config and no `${workspaceFolder}` expansion — so the
registration is user-level:

| File                                             | Purpose                                                                     |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| `~/.cline/data/settings/cline_mcp_settings.json` | Registers the `concord-mcp` stdio server with `CONCORD_AGENT_KIND=cline`    |
| `~/Documents/Cline/Hooks/<Hook>`                 | Lifecycle hooks, read by the extension and the SDK                          |
| `~/.cline/hooks/<Hook>`                          | The same hooks for SDK/CLI layouts (`CLINE_DIR`-aware)                      |
| `.clinerules/concord.md`                         | Concord workflow rules (repository, written by `concord setup`)             |
| `.cline/rules/concord.md`                        | The same rules for the newer rules directory (repository)                   |
| `~/.cline/rules/concord.md`                      | User-level rules when global mode is on                                     |

The settings path honors `CLINE_MCP_SETTINGS_PATH`, `CLINE_DATA_DIR`, and
`CLINE_DIR`, matching Cline's own resolution order.

All files are merged into existing content. Unrelated MCP servers, settings,
rules, and same-named hooks the user owns are preserved, and re-running setup
is idempotent. An unreadable or malformed settings file is reported and left
untouched.

On Windows the hook files are `<HookName>.ps1`; elsewhere they are
extensionless executables, which is what each Cline surface requires. Hook
files carry a `concord:cline-hook` marker; uninstall and global-mode removal
only ever delete files Concord wrote.

## Identity

Cline's MCP server cannot see the session: its registration is one global
file, so `CONCORD_AGENT_KIND=cline` pins the kind but no session variable
exists to derive an id from. Concord's lifecycle hooks know the task id, so
they register a stable `cline:<hash(task_id)>` identity — the same id across
resumes of the task — and, in the VS Code extension, print it into context as
this session's `agent_id`.

Pass that `agent_id` explicitly on `start_work`, `update_work`,
`transfer_work`, and `finish_work`. On `inspect_work`, leave `agent_id` off
unless you are reading your own inbox. The CLI cannot show hook output, so a
CLI session finds its `cline:*` agent in `inspect_work`'s workspace view, or
runs `concord inbox register --provider cline --agent cline:<label>` once and
reuses the id it prints. For a human-chosen name, set `CONCORD_AGENT_ID`
before starting Cline; it wins over the derived id.

## Workspace routing

Cline's extension can start the MCP server with a working directory that has
nothing to do with the open workspace, and Cline offers no MCP roots
capability for the server to ask. The deterministic answer is the hook: its
payload carries `workspace_roots`, so Concord computes that repository's
`workspace_id` and the hook context tells the agent to pass
`workspace_id` on every call. When the agent omits it, the server resolves
the workspace from its own working directory — correct for CLI sessions,
which are launched from the repository.

If a response ever shows the wrong repository, pass `workspace_id`
explicitly; the id is stable for the checkout.

## Delivery

Concord installs three global hooks:

- `TaskStart` / `TaskResume` register presence, advertise the pull endpoint,
  and emit the session-start context (agent id, workspace id, roster).
- `UserPromptSubmit` drains pending messages into the prompt's context —
  **only for extension payloads**. The SDK/CLI runs hooks detached and never
  shows their output, so draining there would mark messages delivered that no
  session sees; those sessions get an endpoint refresh instead and pull from
  the durable inbox.

Cline has no hook that wakes an idle session, so Concord reports Cline as
`busy` reachable only. A message sent while the session is idle waits in the
durable inbox. Nothing polls, and no background monitor is started.

To read the inbox manually from the repository:

```bash
concord inbox drain --agent <agent_id> --provider cline
```

## Manual MCP registration

If you manage client configuration yourself, add this to
`cline_mcp_settings.json` (path above, honoring the same env overrides):

```json
{
  "mcpServers": {
    "concord": {
      "command": "concord-mcp",
      "env": {
        "CONCORD_AGENT_KIND": "cline"
      }
    }
  }
}
```

Then install the hook files from `~/Documents/Cline/Hooks/` (or
`~/.cline/hooks/`): on Windows `<HookName>.ps1`, elsewhere an extensionless
executable. Each forwards the JSON payload on stdin to `concord hook
cline-<event>` for `TaskStart`, `TaskResume`, and `UserPromptSubmit`.
