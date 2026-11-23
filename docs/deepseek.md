# DeepSeek Harness

Concord integrates with the `dsh` CLI from
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), through its
native `@deepseek-ai/dsh-mcp-client` plugin. This is an integration with the
coding harness, independent of which model provider it uses.

## Setup

Install Concord and DeepSeek Harness, then run `concord setup` from your
repository. When `dsh` is on PATH, setup adds a native MCP plugin row to
`$DSH_HOME/cordis.patch.yml` (default `~/.dsh/cordis.patch.yml`). DeepSeek applies
that user patch to its profiles automatically. Concord preserves other patches,
comments and `!!js` expressions without evaluating them during setup. Rerunning
setup preserves edits to the installed row; a conflicting unmarked entry or an
invalid file is left untouched and reported.

DeepSeek Harness 0.2.2-rc.1 requires Node.js >= 24.9, independently of Concord's
own Node.js requirement.

Project instructions go into `AGENTS.md`, which DeepSeek's standard base-backed
profiles load. With Concord global mode enabled, the user-level instructions
also go into `$DSH_HOME/AGENTS.md`. The minimal SDK profile does not load these
instruction files; it still receives Concord's MCP server instructions.

The installed row is equivalent to:

```yaml
- insert:
    - id: concord-mcp # Managed by Concord MCP.
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: concord
        transport: stdio
        command: concord-mcp
        cwd: !!js process.cwd()
        env:
          CONCORD_AGENT_KIND: deepseek
          CONCORD_REPO_ROOT: !!js process.cwd()
```

`concord-mcp` must be on DeepSeek's PATH. The repository comes from the directory
where you launch `dsh`; launch a separate process from each repository. Changing
a session's directory in an already-running DeepSeek host does not move this MCP
server to another workspace.

## Session identity

DeepSeek's MCP initialization identifies the client as `dsh-mcp-client`, but
does not provide a reliable per-agent session ID or MCP roots. Concord therefore
uses its existing explicit identity mechanism. Choose a different ID for each
independent DeepSeek process before launching it:

```sh
cd /path/to/repository
export CONCORD_AGENT_ID="deepseek:$(node -e 'console.log(require("node:crypto").randomUUID())')"
dsh web
```

The native MCP plugin forwards that environment variable, and the installed row
pins the kind to `deepseek`. Inherited Claude or Goose session variables cannot
change that kind. Keep one coordinating agent session per DeepSeek host: the
global MCP plugin shares its server identity across chats. Use separate hosts
for independent agents. Do not put a fixed shared agent ID into the user patch.

If the MCP process cannot inherit the variable, give the session a unique ID
explicitly with `concord inbox register --provider deepseek --agent <unique-id>`
and pass that same `agent_id` on write calls and `kind: deepseek` on `start_work`. Concord does
not invent a stable DeepSeek identity from a client name or borrow a parent
harness's session. Registration without either an explicit ID or a supported
session source fails visibly.

## Workflow and messages

DeepSeek exposes `mcp__concord__start_work`, `inspect_work`, `update_work`,
`transfer_work` and `finish_work`. Check the `repo_root` returned by the first
call before claiming work. Presence and dashboard output use the `deepseek`
agent kind.

Register the durable inbox from the same repository, using the same identity as
the MCP server:

```sh
concord inbox register --provider deepseek --agent "$CONCORD_AGENT_ID"
concord inbox drain --provider deepseek --agent "$CONCORD_AGENT_ID"
```

Register before peers send prompts. During a running turn, drain between work
steps and while expecting a reply; draining refreshes the inbox's 90-second
lease. An explicitly identified MCP client can also read its own inbox with
`inspect_work` and reply through `update_work` using the message ID. Repeat
registration/draining after the lease expires.

Idle wake-up is **not verified**. DeepSeek has session APIs, but an MCP connection
does not give Concord a verified route from its identity to a particular live
DeepSeek agent. Messages stay in the durable inbox until the recipient reads
them. Neither setup nor `concord inbox watch --provider deepseek` advertises
idle reachability. Ask the agent to check its inbox when starting a new turn.

## Status and removal

`concord adapters status` and `concord doctor` report DeepSeek detection and its
native MCP registration. An installed registration reports `pull, busy`; it
does not promise that an inbox receiver is running. `concord adapters install`
reapplies setup, and `concord adapters uninstall` removes only Concord's marked
plugin row while preserving other configuration.

## Verification

Verified with published DeepSeek Harness 0.2.2-rc.1, Node.js 26.0.0, and Codex CLI
0.167.0-alpha.3.2 on macOS arm64. An isolated `sdk-minimal` profile loaded the
generated user patch, discovered all five tools and called each successfully in
the expected repository. A programmatic driver called DeepSeek's native MCP
tool definitions; an actual Codex CLI session used a local scripted model to
send a prompt, read DeepSeek's reply through `inspect_work`, and finish its turn.
No model-provider credentials were needed. DeepSeek model-driven turns,
Web/Desktop UI, Windows/Linux runtime launches, and idle wake-up were not tested.

Configuration references:
[native MCP plugin](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md),
[persistent user patches](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/mcp-memory.md),
[instruction loading](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/context/agent-instructions/README.md).
