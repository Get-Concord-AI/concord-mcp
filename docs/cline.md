# Cline

Concord supports Cline — the CLI (`cline`) and the VS Code extension, which
share one configuration (JetBrains surfaces are unverified). Run
`concord setup` in a repository and Cline gets the five Concord workflow
tools, always-on rules, and global lifecycle hooks that register each task
and deliver peer messages on the next prompt in the VS Code extension.

Cline is detected from `cline` on `PATH`, an existing `~/.cline` or
`Cline` directory under the OS Documents folder (or `~/Documents`), or a
VS Code-family extension install (`saoudrizwan.claude-dev` in
`globalStorage`), including an extension that has never run far enough to
create `~/.cline`.

## What setup writes

Cline has **one global MCP settings file** shared by every project — there is
no project-scoped MCP config and no `${workspaceFolder}` expansion — so the
registration is user-level:

| File                                             | Purpose                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `~/.cline/data/settings/cline_mcp_settings.json` | Registers the `concord-mcp` stdio server with `CONCORD_AGENT_KIND=cline` |
| `<Documents>/Cline/Hooks/<Hook>`                 | Lifecycle hooks, read by the extension (and the SDK where it scans)      |
| `~/Documents/Cline/Hooks/<Hook>`                 | The same hooks for the SDK's own Documents lookup                        |
| `~/.cline/hooks/<Hook>`                          | The same hooks for SDK/CLI layouts (`CLINE_DIR`-aware)                   |
| `.cline/rules/concord.md`                        | Concord workflow rules (repository, written by `concord setup`)          |
| `.clinerules/concord.md` or `.clinerules`        | The same rules when the repo already uses the legacy layout              |
| `~/.cline/rules/concord.md`                      | User-level rules when global mode is on (SDK/CLI global rules dir)       |
| `<Documents>/Cline/Rules/concord.md`             | The same rules where the extension and SDK resolvers look                |

`<Documents>` is the OS Documents folder resolved the way Cline resolves
it — the `MyDocuments` known folder on Windows (which follows OneDrive
folder redirection), `xdg-user-dir DOCUMENTS` on Linux, `~/Documents` as
the fallback — plus the literal `~/Documents` the SDK resolver scans.
`CONCORD_DOCUMENTS_DIR` overrides the lookup. The settings path honors
`CLINE_MCP_SETTINGS_PATH`, `CLINE_DATA_DIR`, and `CLINE_DIR`, matching
Cline's own resolution order. Paths were verified against `cline/cline`
`main` — including the extension's legacy migration that moves MCP
settings from VS Code `globalStorage` into this shared file — against
Cline v3.x; payload parity was checked, not a live extension session.

All files are merged into existing content. Unrelated MCP servers,
settings, rules, and same-named hooks the user owns are preserved, and
re-running setup is idempotent. The `concord` MCP entry Concord writes
carries a `CONCORD_MANAGED` env marker: only a marked entry is rewritten
or removed, so a hand-written `concord` server — even one pinned with
`CONCORD_REPO_ROOT` — survives setup and uninstall. An unreadable or
malformed settings file is reported and left untouched.

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
unless you are reading your own inbox. The CLI/SDK never shows hook output,
so a CLI session cannot discover the `cline:*` id its hooks registered —
and two CLI sessions in one repo would both appear in the roster anyway.
Instead, set `CONCORD_AGENT_ID` before starting Cline (it wins over the
derived id), or register a fresh id once per session —
`concord inbox register --provider cline --agent cline:<unique-label>` —
and reuse it only within that session. Never reuse an id across sessions:
two sessions sharing one claim work and drain each other's inbox.

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

- `TaskStart` / `TaskResume` register presence and, except on the SDK/CLI
  surface, advertise the pull endpoint; they emit the session-start context
  (agent id, workspace id, roster). The SDK runs hooks detached and its
  output never reaches the model, so the `cline:<hash>` id it would
  register is one nobody can address — no endpoint is advertised there,
  which would only leave a ghost that looks reachable.
- `UserPromptSubmit` drains pending messages into the prompt's context —
  **only for extension payloads**, and only as many as fit under Cline's
  50,000-character `contextModification` cap; the rest stay pending for the
  next prompt. The SDK/CLI runs hooks detached and never shows their
  output, so draining there would mark messages delivered that no session
  sees; those sessions get a pending-count notice instead and pull from
  the durable inbox.

Cline has no hook that wakes an idle session, so Concord reports Cline as
`busy` reachable only. A message sent while the session is idle waits in the
durable inbox. Nothing polls, and no background monitor is started.

To read the inbox manually from the repository:

```bash
concord inbox drain --agent <agent_id> --provider cline
```

## Concord Cloud

On a machine linked to Concord Cloud (`concord cloud login`), the same hooks
register the session and drain the inbox against the cloud instead of the
local store, and the globally registered `concord-mcp` proxies its tool calls
to the cloud project resolved from the server's own working directory. Cline
has no MCP roots capability, so when the extension launches that server
outside the repository the hook context still computes the workspace's
`workspace_id` and tells the agent to pass it — the routing is right the
moment the cloud proxy decodes it, which ships separately (#411); until that
lands, calls without a decoded workspace keep the project the server started
for, so run Cline with the MCP server inside the repository. Pass
`workspace_id` explicitly either way — the session-start message already
tells the agent to — and reads and writes land in the project the hook
registered, not wherever the server process happened to
start.

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

Then install the hook files from the `Cline/Hooks` directory under your
OS Documents folder (or `~/Documents/Cline/Hooks/`, `~/.cline/hooks/`): on
Windows `<HookName>.ps1`, elsewhere an extensionless executable. Each
forwards the JSON payload on stdin to `concord hook cline-<event>` for
`TaskStart`, `TaskResume`, and `UserPromptSubmit`.
