# Other MCP clients

An MCP client without a Concord adapter can use the five workflow tools over
stdio. Configure the server manually: `concord setup` does not register Windsurf,
Zed, or VS Code for you. An MCP connection alone does not provide live push
delivery into an agent session.

## Prepare the workspace

Install Node.js >= 22.12, with `npx` available to the client. Open the repository
you want the agents to coordinate in, then initialize its state and instructions:

```sh
npx -y --package @concord-ai/concord-mcp@0.14.2 concord setup --no-mcp --no-adapters
```

`--no-mcp` skips MCP client registration. `--no-adapters` also skips installing
global harness adapters. Review any setup prompts before enabling global mode;
it is not required for this repository-local setup.

If Concord is already installed globally, the equivalent command is:

```sh
concord setup --no-mcp --no-adapters
```

The CLI is `concord`; the stdio server is `concord-mcp`. Do not use the CLI's
`setup` command as the MCP server command.

## Generic stdio server entry

Add this **server entry** using your client's MCP configuration format. The
configuration file location and surrounding object differ between clients; this
is not a complete configuration file for every client.

```json
{
  "command": "npx",
  "args": ["-y", "@concord-ai/concord-mcp@0.14.2"],
  "env": {
    "CONCORD_REPO_ROOT": "/absolute/path/to/your/repository",
    "CONCORD_AGENT_KIND": "your-client-name",
    "CONCORD_AGENT_ID": "your-client:replace-with-unique-session-id"
  }
}
```

With a global installation, use `"command": "concord-mcp"` and omit `args`.
Commands must be on the client's PATH, or replaced with absolute executable
paths. The first `npx` launch may take longer while it downloads the package.

- `CONCORD_REPO_ROOT` selects the repository explicitly. It takes precedence over
  `CLAUDE_PROJECT_DIR`, then the server's working directory. Set it when a client
  launches servers outside the repository. Use an absolute path; `~` is not a
  shell expansion inside JSON.
- `CONCORD_AGENT_KIND` labels the client kind. It does not create a live delivery
  adapter or supply a session identity. Follow the workflow's agent identity
  requirements when calling write tools; do not reuse another session's id.
- `CONCORD_AGENT_ID` supplies the session identity for a client Concord cannot
  identify automatically. Before starting the server, replace the example value
  with an operator-chosen id unique to this agent session. `CONCORD_AGENT_KIND`
  alone is insufficient: a write call without a resolvable identity fails with
  "Concord cannot tell which session you are." The server uses the configured
  identity when the generated instructions tell the agent to omit `agent_id`.
- Keep one identity per agent session. Do not share this server process/id
  between independent chats or agents: they would act as the same owner. For a
  new session, set a new id and restart the server. If the client shares one
  server across chats, use separate client/server instances for independent
  agents rather than changing the identity underneath ongoing work.
- Replace the repository path for each workspace. A user-level server entry
  pinned to one repository keeps using that repository when you open another.

## VS Code example

Create `.vscode/mcp.json` in the opened repository:

```json
{
  "servers": {
    "concord": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@concord-ai/concord-mcp@0.14.2"],
      "env": {
        "CONCORD_REPO_ROOT": "${workspaceFolder}",
        "CONCORD_AGENT_KIND": "vscode",
        "CONCORD_AGENT_ID": "vscode:replace-with-unique-session-id"
      }
    }
  }
}
```

This uses VS Code's `servers` format, not a generic `mcpServers` wrapper.
`${workspaceFolder}` is expanded by VS Code. See its
[MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration).

1. Open the repository folder in VS Code. Replace the example `CONCORD_AGENT_ID`
   with a unique id for this session before starting the server.
2. Run **MCP: List Servers** from the Command Palette, select **concord**, and
   choose **Start Server**. Review the workspace/server trust prompts.
3. Check the server output for **Discovered 5 tools**. The tools are `start_work`,
   `inspect_work`, `update_work`, `transfer_work`, and `finish_work`.
4. From the same server menu, choose **Browse Resources**, then **Concord work
   state**. Check that the returned `repo_root` is the repository you opened.
5. When using an agent, make Concord's tools available to it and ask it to follow
   the generated `AGENTS.md` workflow before editing. A running server does not
   by itself prove that a particular chat session is using its tools.

**Verified:** VS Code 1.137.0 on macOS arm64, Node.js 24.19.0, and the published
Concord 0.14.2 package. In an isolated workspace, the server started through `npx`,
discovered all five tools, and returned the correct repository through
`concord://work-state`. The setup command above was also run with a temporary
HOME. Executable paths were made absolute for the test machine. A separate SDK stdio check against the same published package verified
that `start_work` without an identity fails, while setting `CONCORD_AGENT_ID`
allows `start_work`, `inspect_work`, and `finish_work` with no `agent_id` argument.
Model-driven tool calls and live push delivery were not tested. Windows, Linux, Windsurf, and
Zed were not tested; consult each client's configuration documentation rather
than copying the VS Code wrapper into it.

## Reading messages without an adapter

The workflow tools share durable state, but there is no live push delivery
without a supported harness adapter. An idle agent is not woken merely because
another agent sent it a message.

Have the agent call `inspect_work` with its own `agent_id` to read its
communication inbox/outbox, and check it at appropriate points during work.
Call `inspect_work` without selectors to inspect the workspace, or with
`task_id` to inspect one task; use at most one selector per call. Follow
`start_work` → progress/ownership updates → `finish_work` as described in the
repository instructions. Do not assume manual MCP setup adds the lifecycle
hooks or prompt injection provided by the supported adapters.
