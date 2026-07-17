# Concord MCP

**Shared work-state for coding agents.** Concord MCP gives Claude Code, Codex,
Cursor, and other MCP-capable coding assistants a shared work log. Agents can
claim work, leave handoffs, and generate review-ready packets before opening PRs.

> ⚠️ Early and under active development. The v0 surface is three MCP tools:
> `claim_work`, `handoff`, and `review_ready`.

## Why

Agents work well in isolation, but their plans, assumptions, and decisions only
become visible at PR time. Teams hack around this today with `AGENTS.md`, handoff
files, worktrees, and custom scripts. Concord packages the smallest useful version
of that: a local place for agents to record what they are doing while they do it.

## Install

```bash
npm install -g concord-mcp
concord install
```

Then, in a supported assistant:

```text
/concord start TASK-12
```

> **Client note:** `/concord` is available only where `concord install` can
> register a slash command or equivalent. On other MCP-capable clients, agents use
> the same Concord tools through MCP plus the installed assistant instructions.
> There is no universal slash command across every client.

## What you get

SQLite is the local source of truth (gitignored). Concord renders human-readable
artifacts you can commit so they show up in PRs:

```text
.concord/
├── concord.db          local source of truth (gitignored)
├── HANDOFF.md          human-readable handoff
├── REVIEW_PACKET.md    review-ready evidence
└── WORK_STATE.json     generated export (optional)
```

## What this is

Shared work-state and guardrails for the coding agents you already use.

## What this is not

Not an orchestrator, code reviewer, memory vector DB, or autonomous coding agent.

## Why not just use markdown?

Markdown handoff files are a good start. Concord makes them structured, queryable
by agents, visible to humans, and harder to skip.

## Development

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) and [`CLAUDE.md`](./CLAUDE.md). This
repo is strictly typed (no `any`, no typecasts), modular, and every PR stays under
600 LOC.

## License

[MIT](./LICENSE)
