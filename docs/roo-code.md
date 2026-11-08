# Using Concord with Roo Code

Run `concord setup --repo-files` in the repository. Roo Code needs project files
even when global mode is on, because Concord has no user-level Roo setup. Setup
registers Concord's MCP server in the project's `.roo/mcp.json` and writes the
Concord workflow instructions to `.roo/rules/concord.md`. Existing MCP servers,
settings, and rule content are preserved, and re-running setup leaves the files
unchanged.

Roo Code is a VS Code extension rather than a command-line tool, so Concord does
not look for an executable. Like the other project-scoped configs, the files are
written whenever `concord setup` runs.

Roo Code has no verified session wake or resume mechanism. Concord can register
its MCP server with Roo Code, but live inbox messaging is not currently
supported. Do not expect live inbox messages to reach Roo Code sessions yet.

Concord has no verified way to read a Roo Code session id, so it cannot derive
the agent's identity on its own. The installed rule tells the agent to run
`concord inbox register` and pass the `agent_id` it prints. You can also set
`CONCORD_AGENT_ID` before starting the session.

## Configuration

Concord is written to the project-level Roo Code files:

- **MCP server**: `.roo/mcp.json`
- **Instructions**: `.roo/rules/concord.md`

The entry added to `.roo/mcp.json` looks like:

```json
{
  "mcpServers": {
    "concord": {
      "command": "concord-mcp",
      "env": {
        "CONCORD_REPO_ROOT": "/path/to/your/repository",
        "CONCORD_AGENT_KIND": "roo"
      }
    }
  }
}
```

> **Note:** `CONCORD_REPO_ROOT` is the absolute path of your checkout, so
> `.roo/mcp.json` is specific to your machine. Consider adding it to your
> `.gitignore` instead of committing it.

A `concord` server you added yourself is left untouched, and so is any other
server in the file. If `.roo/mcp.json` is not valid JSON, setup reports the path
and leaves the file as it is.
