# Concord MCP

[![npm version](https://img.shields.io/npm/v/@concord-ai/concord-mcp.svg)](https://www.npmjs.com/package/@concord-ai/concord-mcp)
[![npm downloads](https://img.shields.io/npm/dm/@concord-ai/concord-mcp.svg)](https://www.npmjs.com/package/@concord-ai/concord-mcp)
[![CI](https://github.com/Get-Concord-AI/concord-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Get-Concord-AI/concord-mcp/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/node/v/@concord-ai/concord-mcp.svg)](https://www.npmjs.com/package/@concord-ai/concord-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

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
npm install -g @concord-ai/concord-mcp
concord install
```

`concord install` writes Concord's tool instructions into your client configs
(`CLAUDE.md`, `AGENTS.md`, `.codex/`, `.cursor/rules/`). Then register the MCP
server with your client and let your agent use the tools through MCP. Per-client
setup:

- [Claude Code](./docs/claude-code.md)
- [Codex](./docs/codex.md)
- [Cursor](./docs/cursor.md)

> There is no universal `/concord` slash command — commands are client-specific.
> Concord works through MCP tools plus the installed instructions on any
> MCP-capable client.

## The three tools

| Tool           | When                 | What it does                                                                     |
| -------------- | -------------------- | -------------------------------------------------------------------------------- |
| `claim_work`   | before editing       | records the task + expected files/modules; flags overlaps with other active work |
| `handoff`      | when done or blocked | captures what changed, tests run, assumptions, decisions, guardrails             |
| `review_ready` | before a PR          | records plan, tests, open questions, and provenance                              |

## What you get

SQLite is the local source of truth. `concord init` adds `.concord/` to the
repository's `.gitignore`, so the generated workspace stays local by default.
Teams that want selected artifacts in PRs can remove that rule or force-add the
human-readable files:

```text
.concord/
├── concord.db          local source of truth
├── HANDOFF.md          human-readable handoff
├── REVIEW_PACKET.md    review-ready evidence
└── WORK_STATE.json     generated export (optional)
```

## CLI

Agents use the MCP tools; humans use the CLI.

```bash
concord init                 # create the .concord/ workspace
concord status               # active work, overlaps, review-ready, open questions
concord tasks                # list all tracked tasks
concord handoff <task-id>    # print the latest handoff
concord review-packet <id>   # print the latest review packet
concord export markdown      # regenerate .concord/ artifacts
concord doctor               # workspace checks + per-task tool adoption
```

## Try the demo

```bash
pnpm demo
```

Runs the [two-agent overlap demo](./examples/two-agent-overlap/): two agents claim
overlapping work (Concord flags it), then one hands off and marks the task
review-ready — printing the generated artifacts.

## What this is / is not

Shared work-state and guardrails for the coding agents you already use. **Not** an
orchestrator, code reviewer, memory vector DB, or autonomous coding agent.

See also: [Why not just use markdown?](./docs/why-not-markdown.md)

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) and [`CLAUDE.md`](./CLAUDE.md). This
repo is strictly typed (no `any`, no typecasts), modular, and every PR stays under
600 LOC. Good first issues are labelled [`good first issue`](https://github.com/Get-Concord-AI/concord-mcp/labels/good%20first%20issue).

## Star History

<a href="https://www.star-history.com/?repos=Get-Concord-AI%2Fconcord-mcp&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Get-Concord-AI/concord-mcp&type=date&theme=dark&legend=top-left&sealed_token=DbdI1sO4OagCGFjVA8u5Muv8TyjExR3cllFEq-O_HR3Lzj1jwj7p3N1KuL5fqohiyjzgevkwPQTT8oAw-rZfwTGNwRcTD9sb7aM0pDiJ6ZFGbGY2swwz0CNpbh3Usu4Dw6UIXBDuXacj3SBUTvdU7UYqEcAZtYdlTqUphLqPIrnMJa9WbAbg4ksGqaU2" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Get-Concord-AI/concord-mcp&type=date&legend=top-left&sealed_token=DbdI1sO4OagCGFjVA8u5Muv8TyjExR3cllFEq-O_HR3Lzj1jwj7p3N1KuL5fqohiyjzgevkwPQTT8oAw-rZfwTGNwRcTD9sb7aM0pDiJ6ZFGbGY2swwz0CNpbh3Usu4Dw6UIXBDuXacj3SBUTvdU7UYqEcAZtYdlTqUphLqPIrnMJa9WbAbg4ksGqaU2" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=Get-Concord-AI/concord-mcp&type=date&legend=top-left&sealed_token=DbdI1sO4OagCGFjVA8u5Muv8TyjExR3cllFEq-O_HR3Lzj1jwj7p3N1KuL5fqohiyjzgevkwPQTT8oAw-rZfwTGNwRcTD9sb7aM0pDiJ6ZFGbGY2swwz0CNpbh3Usu4Dw6UIXBDuXacj3SBUTvdU7UYqEcAZtYdlTqUphLqPIrnMJa9WbAbg4ksGqaU2" />
 </picture>
</a>

## License

[MIT](./LICENSE)
