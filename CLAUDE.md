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

1. **PRs stay under 600 LOC** (added + removed, excluding `pnpm-lock.yaml`).
   Enforced by the `pr-size-check` CI job. If a change grows past this, split it.
2. **No file over 1000 lines.** Enforced by ESLint `max-lines`. Aim far lower —
   most files should be under ~300 lines. Extract modules early.
3. **Strict types. Never `any`.** `strict` + `noUncheckedIndexedAccess` +
   `exactOptionalPropertyTypes` in tsconfig; `strictTypeChecked` in ESLint
   (`no-explicit-any`, all `no-unsafe-*`, `no-non-null-assertion`).
4. **`unknown` only at boundaries.** `unknown` is allowed **only** as the
   immediate input to a Zod `.parse()` / `.safeParse()` that narrows it. Never
   store, return, or pass around `unknown`.
5. **Never typecast.** `as` assertions are forbidden (`consistent-type-assertions:
never`); only `as const` is allowed. Narrow types with Zod parsing, type
   guards, or control flow — not casts.
6. **Clear naming.** camelCase values/functions, PascalCase types, UPPER_CASE
   module constants. kebab-case filenames. Enforced by `naming-convention`.
7. **Modular, layered structure** (see below). Dependencies point one way:
   `tools` / `cli` → `domain` / `artifacts` → `db` → `config`. Lower layers never
   import higher ones.
8. **Check before writing.** Search for an existing type, schema, repository, or
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
pnpm install          # native better-sqlite3 build is allowlisted for pnpm 10
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
concern per PR; keep it under 600 LOC.
