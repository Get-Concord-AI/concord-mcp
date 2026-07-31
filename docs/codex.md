# Using Concord with Codex

## 1. Install

```bash
npm install -g @concord-ai/concord-mcp
```

## 2. Set up your repo

```bash
concord setup
```

This creates `.concord/` and registers the MCP server in your Codex config
(`~/.codex/config.toml`, or `$CODEX_HOME/config.toml` when that is set):

```toml
[mcp_servers.concord]
command = "concord-mcp"
```

and writes a Concord block into `AGENTS.md` (and `.codex/concord.md`) describing
when to claim work, share task context, and hand off. The rest of your config —
other tables, and the comments around them — is left as-is, and re-running is a
no-op. Pass `--no-mcp` to write only the instructions and add the table above
yourself.

Note this is the one file `concord setup` writes outside the repo, since Codex
keeps MCP servers in user-global config rather than per-project. Refer to the
current Codex MCP documentation if the config format has changed.

## 3. Use it

Codex should call `start_work` before editing, `update_work` while working, and
`inspect_work` when resuming or coordinating. Assignments, acceptance, and
handoffs use `transfer_work` with the task's current version. Before a PR it
calls `finish_work` with `outcome: "review_ready"` and the evidence needed for
review. Track it from your terminal:

```bash
concord status
concord doctor
```

With the live-prompt integration approved by `concord setup --agent-comms`,
another workspace agent can address this Codex session through `update_work`.
The Codex app-server adapter uses `turn/steer` during an active turn and
`turn/start` while idle; existing sessions need one restart after installation.

> Enforcement is instruction-based on clients without hooks — `concord doctor`
> makes skipped tools visible regardless.
