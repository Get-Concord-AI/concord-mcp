# Using Concord with Codex

## 1. Install

```bash
npm install -g @concord-ai/concord-mcp
```

## 2. Register the MCP server

Add Concord to your Codex config (`~/.codex/config.toml`):

```toml
[mcp_servers.concord]
command = "concord-mcp"
```

Refer to the current Codex MCP documentation if the config format has changed.

## 3. Install the agent instructions

```bash
concord install
```

This writes a Concord block into `AGENTS.md` (and `.codex/concord.md`) describing
when to claim work, share task context, and hand off. It is idempotent.

## 4. Use it

Codex should call `claim_work` before editing, `update_task` while working, and
`get_task_context` when resuming or coordinating. Before a PR it calls `handoff`
with `ready_for_review`. Track it from your terminal:

```bash
concord status
concord doctor
```

> Enforcement is instruction-based on clients without hooks — `concord doctor`
> makes skipped tools visible regardless.
