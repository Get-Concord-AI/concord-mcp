# Using Concord with Google Antigravity

Concord provides first-class, native MCP integration with Google Antigravity (Antigravity IDE, Antigravity 2.0, and `agy` CLI).

## Setup

Run `concord setup` in your repository:

```bash
concord setup
```

`concord setup` configures Concord without overwriting any existing Antigravity settings or custom tools:

- **Workspace MCP configuration**: Registers the Concord MCP server in `.agents/mcp_config.json` with `CONCORD_AGENT_KIND=antigravity`.
- **Workspace lifecycle hooks**: Writes `.agents/hooks.json` configuring `SessionStart`, `PreInvocation`, and `Stop` hooks for automatic identity registration and turn message injection.
- **Workspace rules**: Injects Antigravity-tailored coordination guidance into `.agents/rules/concord.md` (with `trigger: always_on` frontmatter) and updates root `AGENTS.md`.
- **Global configuration**: When global mode is active, registers user-scoped MCP tools in `~/.gemini/config/mcp_config.json`, global hooks in `~/.gemini/config/hooks.json`, and global rules in `~/.gemini/config/rules/concord.md`.

## Coexistence with Gemini CLI

Both Antigravity and Gemini CLI utilize the `~/.gemini/` parent directory, but their configuration targets are distinct:

| Target              | Antigravity                              | Gemini CLI                |
| :------------------ | :--------------------------------------- | :------------------------ |
| **Workspace MCP**   | `.agents/mcp_config.json`                | `.gemini/settings.json`   |
| **Workspace Hooks** | `.agents/hooks.json`                     | N/A                       |
| **Workspace Rules** | `.agents/rules/concord.md` / `AGENTS.md` | `GEMINI.md`               |
| **Global MCP**      | `~/.gemini/config/mcp_config.json`       | `~/.gemini/settings.json` |
| **Global Hooks**    | `~/.gemini/config/hooks.json`            | N/A                       |
| **Global Rules**    | `~/.gemini/config/rules/concord.md`      | `~/.gemini/GEMINI.md`     |

`concord setup` and `concord adapters install` maintain strict separation between these paths. Installing or uninstalling Antigravity never mutates or clobbers Gemini CLI settings.

## Session Identity & Isolation

Antigravity derives a deterministic, stable identity (`antigravity:<8-hex-hash>`) from the session:

1. **Antigravity IDE**: `ANTIGRAVITY_CONVERSATION_ID` environment variable is automatically detected.
2. **Headless `agy` CLI**: The `SessionStart` and `PreInvocation` hooks read `conversationId` from stdin, register the agent, and inject `antigravity:<hash>` into model context via ephemeral step injection.
3. **Isolation**: `.agents/mcp_config.json` sets `CONCORD_AGENT_KIND=antigravity`, preventing the MCP server process from inheriting parent terminal session variables (e.g. `CLAUDE_CODE_SESSION_ID`).
4. **Fallback**: If unhooked or unconfigured, Concord falls back cleanly to explicit session registration:
   ```bash
   concord inbox register --provider antigravity
   ```

## Delivery Semantics

Antigravity advertises `busy` reachability:

- Active agent turns pull peer messages, claim file scopes, and exchange handoffs directly via Concord's MCP tools.
- Because `agy` exposes only plain text output to the model, `.agents/hooks.json` includes a `PreInvocation` hook that drains inbox messages and injects them directly into the turn context as messages.
- A `Stop` hook checks for pending messages and continues the turn if new peer messages arrived before completion.
- Messages can also be manually drained or inspected at any time:
  ```bash
  concord inbox drain --provider antigravity --agent <agent_id>
  ```

## Verification

Check adapter and workspace status:

```bash
concord adapters status
concord adapters doctor
concord who
```
