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
when to call `claim_work`, `handoff`, and `review_ready`. It is idempotent.

## 4. Use it

Codex should call `claim_work` before editing and `handoff` / `review_ready`
before a PR. Track it from your terminal:

```bash
concord status
concord doctor
```

> Enforcement is instruction-based on clients without hooks — `concord doctor`
> makes skipped tools visible regardless.
