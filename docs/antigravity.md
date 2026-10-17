# Using Concord with Google Antigravity

Concord provides first-class, native MCP integration with Google Antigravity (Antigravity IDE, Antigravity 2.0, and `agy` CLI).

## Setup

Run `concord setup` in your repository:

```bash
concord setup
```

`concord setup` configures Concord without overwriting any existing Antigravity settings or custom tools:

- **Workspace MCP configuration**: Registers the Concord MCP server in `.agents/mcp_config.json`.
- **Workspace rules**: Injects coordination guidance into `.agents/rules/concord.md` (with `trigger: always_on` frontmatter) and updates root `AGENTS.md`.
- **Global configuration**: When global mode is active, registers user-scoped MCP tools in `~/.gemini/config/mcp_config.json` and global rules in `~/.gemini/config/rules/concord.md`.

## Coexistence with Gemini CLI

Both Antigravity and Gemini CLI utilize the `~/.gemini/` parent directory, but their configuration targets are distinct:

| Target              | Antigravity                              | Gemini CLI                |
| :------------------ | :--------------------------------------- | :------------------------ |
| **Workspace MCP**   | `.agents/mcp_config.json`                | `.gemini/settings.json`   |
| **Workspace Rules** | `.agents/rules/concord.md` / `AGENTS.md` | `GEMINI.md`               |
| **Global MCP**      | `~/.gemini/config/mcp_config.json`       | `~/.gemini/settings.json` |
| **Global Rules**    | `~/.gemini/config/rules/concord.md`      | `~/.gemini/GEMINI.md`     |

`concord setup` and `concord adapters install` maintain strict separation between these paths. Installing or uninstalling Antigravity never mutates or clobbers Gemini CLI settings.

## Session Identity & Reachability

Antigravity derives a deterministic, stable identity (`antigravity:<8-hex-hash>`) from the session environment:

1. `ANTIGRAVITY_CONVERSATION_ID` or `ANTIGRAVITY_SESSION_ID` environment variables.
2. `conversation_id` / `conversationId` fields when invoked via `.agents/hooks.json`.
3. If an Antigravity environment is detected without a conversation ID, Concord falls back cleanly to explicit session registration rather than generating an unreachable or static identity.

### Delivery Semantics

Antigravity advertises `busy` reachability:

- Active agent turns pull peer messages, claim file scopes, and exchange handoffs directly via Concord's MCP tools.
- Idle sessions receive durable messages in their inbox, delivered when the user next triggers the conversation.

## Verification

Check adapter and workspace status:

```bash
concord adapters status
concord adapters doctor
concord who
```
