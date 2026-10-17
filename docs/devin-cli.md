# Devin CLI

Concord supports the local Devin CLI. Cloud Devin runs in a remote VM and is
outside this integration; it cannot share the local `.concord/` database.

Run `concord setup` in a repository. Setup adds the Concord stdio MCP server to
`.devin/mcp_config.json`, writes the normal Concord instructions to `AGENTS.md`,
and registers session lifecycle hooks in `.devin/hooks.v1.json`. It preserves
other MCP servers and leaves `.devin/mcp_config.local.json` untouched.

Current Devin CLI releases use `mcp_config.json` for MCP servers. On Unix the
user file is `~/.config/devin/mcp_config.json`; on Windows it is
`%APPDATA%\devin\mcp_config.json`. Project servers go in
`.devin/mcp_config.json`. Older releases stored servers under `mcpServers` in
`config.json`; Devin migrates those entries when starting. Concord writes the
dedicated current file and requires Devin CLI v3000.3 or newer for the dedicated
MCP config format. Devin's config format supports comments; Concord's writer
retains existing text and merges its named entry.

Devin CLI reads project `AGENTS.md` and user-level rules from
`~/.config/devin/AGENTS.md` (or `%APPDATA%\devin\AGENTS.md` on Windows). Use
`concord setup --global` to add user-level MCP registration, the managed
instructions block, and the lifecycle hooks under the `hooks` key in Devin's
user `config.json`. Existing top-level settings and comments are retained;
Concord merges the hooks by event and removes only its own commands when global
mode is disabled. Re-running setup is safe.

The lifecycle hooks use Devin's documented `SessionStart`, `UserPromptSubmit`,
and `SessionEnd` events. Each event payload on stdin has a stable `session_id`;
Concord derives `devin:<hash>` from that value instead of relying on an
interactive-only environment variable. Devin also sets `DEVIN_PROJECT_DIR`.
`UserPromptSubmit` drains pending messages and returns them as
`hookSpecificOutput.additionalContext`, so delivery happens on the next user
prompt. The same identity works in `devin -p` and CI whenever Devin invokes the
configured hooks; hook invocation in those modes has not been runtime checked
in this environment.

When handing work to cloud Devin, use `transfer_work` to hand off or release
your claim before the handoff. Cloud Devin cannot access local Concord state;
its completion should be reviewed and claimed locally when it returns.

## Verified behavior

The current official documentation confirms dedicated MCP config paths and
schema, JSON comment support, AGENTS.md discovery, the hook event names,
`session_id`, `DEVIN_PROJECT_DIR`, and `additionalContext` output:

- [MCP configuration](https://docs.devin.ai/cli/extensibility/mcp/configuration)
- [Configuration file and paths](https://docs.devin.ai/cli/reference/configuration/config-file)
- [Rules and AGENTS.md](https://docs.devin.ai/cli/extensibility/rules)
- [Hooks and output format](https://docs.devin.ai/cli/extensibility/hooks/overview)
- [Lifecycle event payloads](https://docs.devin.ai/cli/extensibility/hooks/lifecycle-hooks)

The exact runtime hook invocation and non-interactive behavior should be checked
against the installed Devin CLI version before relying on automatic delivery in
CI. Use `concord inbox inspect` if a session needs to retrieve a message manually.
