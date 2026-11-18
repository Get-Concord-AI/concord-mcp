# Using Concord with Muse Code

Meta's Muse Code is a terminal coding agent built on the Muse Spark model (macOS and Linux). Concord integrates with Muse Code via its stdio MCP server configuration and repository instruction files.

## 1. Setup

### Automatic setup

- **Adapters (MCP server registration)**: Run `concord adapters install` to register Concord in Muse Code settings. When `muse` is detected on `PATH`, Concord writes the MCP entry (see below).
- **Global instructions**: Run `concord setup --global` to write machine-wide workflow instructions to Muse Code’s instruction file (see “Instruction file path” below). Global mode does **not** register the MCP server for Muse Code; adapters own `settings.json`.
- **Repository instructions**: Running `concord setup` in a repository writes workflow guidance into `AGENTS.md` at the repo root. Muse Code loads `AGENTS.md` when launched in a trusted workspace.

### Configuration file

Muse Code reads user settings from:

- `$XDG_CONFIG_HOME/muse/settings.json` if `XDG_CONFIG_HOME` is set
- otherwise `~/.config/muse/settings.json`

Concord writes (or updates) the MCP server entry in `settings.json`. Muse Code requires `"schema_version": 1`; Concord preserves an existing version or sets it to `1` when creating a new file.

**Version gate:** Concord requires Muse Code **v1.2.1 or newer**. Muse Code 1.2.1 introduced `MUSE_SESSION_ID` for stdio MCP servers and `${VAR}` interpolation in MCP config ([Muse Code changelog](https://dev.meta.ai/docs/muse-code/changelog)). Concord uses `MUSE_SESSION_ID` to derive agent identity.

### MCP key and entry shape (important)

- **Root key:** Concord writes the canonical **`mcpServers`** object. If a file already uses only the legacy **`mcp_servers`** key, Concord keeps using it (no new `mcpServers` key is added).
- **Ambiguous:** If **both** `mcpServers` and `mcp_servers` are present, Muse disables MCP for that session; `concord adapters install` refuses to write in that case until you merge to a single key (recommended: `mcpServers`).
- **Entry shape:** Concord registers a stdio server with `transport: "stdio"`, `command: "concord-mcp"`, `mode: "optional"`, and `env` including `CONCORD_AGENT_KIND=muse-code`. This form is compatible with Muse 1.2.1 behavior and is preserved by the Muse 1.3.0 settings rewrite, which keeps `transport`/`mode` but drops `type`/`required` ([Muse Code changelog](https://dev.meta.ai/docs/muse-code/changelog); [Extending Muse Code (MCP)](https://meta-models.github.io/muse-code-sdk/1.4/guides/extend/mcp-servers/)).
- Concord does not set `MUSE_HOME`; Concord uses `XDG_CONFIG_HOME` or the default `~/.config/muse` when locating `settings.json`.

Example (`mcpServers`, canonical):

```json
{
  "schema_version": 1,
  "mcpServers": {
    "concord": {
      "transport": "stdio",
      "command": "concord-mcp",
      "env": {
        "CONCORD_AGENT_KIND": "muse-code"
      },
      "mode": "optional"
    }
  }
}
```

User-owned `concord` entries (custom command/args or extra env beyond `CONCORD_AGENT_KIND`/`CONCORD_REPO_ROOT` patterns Concord treats as its own) are left untouched by adapters and global uninstall of Concord’s managed entries follows the same safety rules as other harnesses.

### Environment and identity

- **`MUSE_SESSION_ID`**: Muse sets this for stdio MCP servers and sets it **last**, replacing inherited/configured values for that variable ([Extending Muse Code (MCP), 1.4](https://meta-models.github.io/muse-code-sdk/1.4/guides/extend/mcp-servers/)). Concord derives agent identity from it.
- **Env allowlist**: Muse limits child server env to an allowlist plus values in the server `env` block, then `MUSE_SESSION_ID`. Put only what is needed in `env` (Concord sets `CONCORD_AGENT_KIND`). `PATH` remains available to the child process as documented by Muse, so `concord-mcp` must be on `PATH`.

### Instruction file path (global mode)

`concord setup --global` writes instructions to `~/.config/muse/AGENTS.md` when resolved under the default Muse config layout (or the same directory as `settings.json` under `XDG_CONFIG_HOME`). Meta’s public docs describe machine-wide/project rules loading in general but do **not** explicitly name this filename in the excerpts reviewed here; treat this path as a Concord convention aligned with the `muse` config directory.

## 2. Agent identity and constraints

- **Session identity**: Muse injects `MUSE_SESSION_ID` into stdio MCP server processes; Concord uses it for `muse-code:<hash>` identity.
- **Subagent limitation (follow-up)**: MCP server process/identity behavior across subagents follows Muse’s current model; if subagents share the session identity in practice, Concord coordinates under the primary session identity until Muse exposes clearer per-thread mapping in MCP.
- **Relay hooks (follow-up)**: Live inbox delivery via Muse relay hooks remains deferred pending upstream support for correlating MCP calls with child thread IDs where applicable.

## 3. Diagnostics and verification

Verify your setup with:

```bash
concord adapters status
concord doctor
```

When `muse` is on your `PATH`, `settings.json` contains a Concord MCP entry in a supported shape (and not the both-keys ambiguous case), and you are on Muse Code v1.2.1+, `concord adapters status` reports Muse Code as `installed` (subject to version gating).

## Sources

- Muse Code changelog (1.2.1, 1.3.0, 1.4.x notes): https://dev.meta.ai/docs/muse-code/changelog
- Extending Muse Code (MCP servers, stdio/HTTP, config semantics): https://meta-models.github.io/muse-code-sdk/1.4/guides/extend/mcp-servers/
- Muse Code configuration (general): https://dev.meta.ai/docs/muse-code/configuration
