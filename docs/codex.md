# Using Concord with Codex

## 1. Install

```bash
npm install -g @concord-ai/concord-mcp
```

## 2. Set up your repo

```bash
concord install
```

This registers the MCP server in your Codex config (`~/.codex/config.toml`, or
`$CODEX_HOME/config.toml` when that is set):

```toml
[mcp_servers.concord]
command = "concord-mcp"
```

and writes a Concord block into `AGENTS.md` (and `.codex/concord.md`) describing
when to claim work, share task context, and hand off. The rest of your config —
other tables, and the comments around them — is left as-is, and re-running is a
no-op. Pass `--no-mcp` to write only the instructions and add the table above
yourself.

Note this is the one file `concord install` writes outside the repo, since Codex
keeps MCP servers in user-global config rather than per-project. Refer to the
current Codex MCP documentation if the config format has changed.

## 3. Use it

Codex should call `claim_work` before editing, `update_task` while working, and
`get_task_context` when resuming or coordinating. An assigned task must be
accepted with its current version before editing. Transfers use
`offer_handoff` plus recipient `accept_handoff`/`decline_handoff`; `handoff`
itself records evidence without changing ownership. Before a PR it calls `handoff`
with `ready_for_review`. Track it from your terminal:

```bash
concord status
concord doctor
```

> Enforcement is instruction-based on clients without hooks — `concord doctor`
> makes skipped tools visible regardless.
