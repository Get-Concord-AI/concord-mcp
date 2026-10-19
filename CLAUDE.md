# Concord MCP — Engineering Guide

This file governs how code is written in this repository. It applies to human
contributors and to coding agents (Claude Code, Codex, Cursor, etc.). Read it
before making changes.

## What this project is

`concord-mcp` is a local MCP server plus a `concord` CLI that gives coding agents
shared work-state: agents **register their presence**, **claim work**, share
typed **task context**, leave **handoffs**, and generate **review packets**
before opening PRs. SQLite is the source of truth; human-readable markdown
artifacts are rendered from it for PR visibility.

The surface is intentionally six MCP tools: `register_agent`, `get_work_state`,
`claim_work`, `update_task`, `get_task_context`, and `handoff`. Review packets
are produced by `handoff` with `ready_for_review` set, not a separate tool.
`register_agent` was added with explicit product pull for agent presence (who is
here and what they are working on); liveness is derived from `last_seen` in
`domain/presence.ts`, not stored. Do not add more tools without explicit product
pull.

## Coding rules (non-negotiable)

These are enforced in CI. A PR that violates them will not go green.

1. **No file over 1000 lines.** Enforced by ESLint `max-lines`. Aim far lower —
   most files should be under ~300 lines. Extract modules early.
2. **Strict types. Never `any`.** `strict` + `noUncheckedIndexedAccess` +
   `exactOptionalPropertyTypes` in tsconfig; `strictTypeChecked` in ESLint
   (`no-explicit-any`, all `no-unsafe-*`, `no-non-null-assertion`).
3. **`unknown` only at boundaries.** `unknown` is allowed **only** as the
   immediate input to a Zod `.parse()` / `.safeParse()` that narrows it. Never
   store, return, or pass around `unknown`.
4. **Never typecast.** `as` assertions are forbidden (`consistent-type-assertions:
never`); only `as const` is allowed. Narrow types with Zod parsing, type
   guards, or control flow — not casts.
5. **Clear naming.** camelCase values/functions, PascalCase types, UPPER_CASE
   module constants. kebab-case filenames. Enforced by `naming-convention`.
6. **Modular, layered structure** (see below). Dependencies point one way:
   `tools` / `cli` → `domain` / `artifacts` → `db` → `config`. Lower layers never
   import higher ones.
7. **Check before writing.** Search for an existing type, schema, repository, or
   helper before adding a new one. Reuse over duplication.

## The "never typecast" pattern for DB rows and external JSON

`better-sqlite3` returns loosely-typed rows and MCP tool args arrive as raw
input. Do **not** reach for `as`. Instead, define a Zod schema and parse:

```ts
// db/rows.ts
const taskRow = z.object({ id: z.string(), title: z.string(), risk_tags: z.string() });

// repository
const raw: unknown = stmt.get(id); // `unknown` is fine here — it dies at parse()
if (raw === undefined) return undefined;
const row = taskRow.parse(raw); // fully typed, no cast
```

The `unknown` never escapes the function; `parse()` produces a typed value.

## Architecture

```text
src/
  index.ts            MCP server entry (stdio)          [bin: concord-mcp]
  server.ts           McpServer construction + tool wiring
  config/paths.ts     .concord/ resolution, repo-root discovery
  db/                 SQLite: connection, schema, row parsers, repositories
  domain/             types, Zod input schemas, overlap detection (pure logic)
  tools/              five-tool MCP surface; review-ready.ts is a
                      handoff-invoked helper, not a registered tool
  artifacts/          render HANDOFF.md / REVIEW_PACKET.md / WORK_STATE.json
  install/            per-client instruction writers
  cli/                commander CLI                     [bin: concord]
test/                 mirrors src/, uses :memory: sqlite
```

Keep `domain/` pure and dependency-free so it is trivially testable. Tools and
CLI commands are thin: validate input → call domain/db → render.

## Working in this repo

```bash
pnpm install          # better-sqlite3 ships prebuilds; the build allowlist is a fallback
pnpm typecheck        # tsc --noEmit
pnpm lint             # eslint (strict, type-aware)
pnpm test             # vitest run
pnpm build            # emit dist/ from src/
pnpm format           # prettier --write
```

Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build` before pushing.

## PR workflow

Every change ships as: **new branch → focused commits → PR → squash-merge to
main**. Branch names: `feat/…`, `fix/…`, `chore/…`, `docs/…`. Commit messages
use Conventional Commits (`feat:`, `fix:`, `chore:`, `ci:`, `docs:`). One logical
concern per PR.

<!-- concord:start -->
## Concord — shared work-state for coding agents

<!-- concord:workflow-version=6 -->

This project uses Concord MCP. Keep coordination to the five workflow tools:

- **Before editing**, call `start_work` with the task, your agent kind, and
  expected files or modules. It registers presence, accepts assigned work when
  appropriate, claims the scope, and returns overlap warnings. Concord derives
  your `agent_id` from your session — omit it unless your client told you one.
- Use `inspect_work` to read the workspace, one task, one agent, or one message
  thread. Use `update_work` for durable progress and for live prompts/replies
  to another promptable workspace agent, including while that agent is busy.
- Use `transfer_work` for assignment, acceptance, decline, release,
  reassignment, evidence-bearing handoff offers, and reopening.
- **Before finishing**, call `finish_work` once with the outcome, changed
  files, tests, assumptions, decisions, risks, guardrails, and provenance. It
  records evidence and can mark work review-ready or terminal.
- Before handing work to cloud Devin, use `transfer_work` to hand off or
  release your local claim; cloud Devin cannot access this local Concord state.

Keep each claim small and resolve reported overlaps before editing. Concord
regenerates human-readable review artifacts in `.concord/`.

Enforcement remains client-dependent. `concord doctor` reports setup and
workflow adoption; optional hooks can block exact-file collisions.

In Grok Build, keep this session reachable while idle by starting one persistent
monitor for `concord inbox watch --provider grok`. Do not start a duplicate when that monitor is active.

In Cursor, start exactly one Cursor background Shell task for `concord inbox watch --provider cursor --once`.
Leave it active when the turn ends. When Cursor resumes you with its completion,
answer the emitted peer message and immediately start a fresh background monitor.

In Gemini CLI, start the exact monitor command supplied by the SessionStart hook
(`concord inbox watch --agent <agent-id> --provider gemini --once`) with `run_shell_command` and `is_background: true`. Project
settings inject background completion into the agent. Answer the peer message,
then immediately start a fresh background monitor.
<!-- concord:end -->
