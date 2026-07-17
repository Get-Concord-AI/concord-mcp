# Contributing to Concord MCP

Thanks for your interest in Concord. This project is small and opinionated on
purpose. Please read [`CLAUDE.md`](./CLAUDE.md) — it defines the coding rules and
architecture, and they are enforced in CI.

## Getting started

```bash
git clone https://github.com/Get-Concord-AI/concord-mcp.git
cd concord-mcp
pnpm install
pnpm test
```

Requires Node.js >= 20 and pnpm 10. `better-sqlite3` builds a native module on
install (allowlisted via `pnpm.onlyBuiltDependencies`).

## Before you write code

- [ ] Search the codebase for an existing type, Zod schema, repository, or helper
      that already does what you need. Reuse beats duplication.
- [ ] Confirm your change fits the layered architecture in `CLAUDE.md`.
- [ ] Keep the planned diff under 600 LOC. If it won't fit, split it.

## Development commands

| Command          | Purpose                                                   |
| ---------------- | --------------------------------------------------------- |
| `pnpm typecheck` | Type-check with the strict `tsconfig`.                    |
| `pnpm lint`      | ESLint (strict, type-aware). `pnpm lint:fix` to autofix.  |
| `pnpm format`    | Prettier write. `pnpm format:check` to verify.            |
| `pnpm test`      | Run the Vitest suite. `pnpm test:watch` while developing. |
| `pnpm build`     | Emit `dist/`.                                             |

Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build` before opening a PR.

## Submitting a change

1. Branch from `main`: `feat/…`, `fix/…`, `chore/…`, or `docs/…`.
2. Make focused commits using [Conventional Commits](https://www.conventionalcommits.org/)
   (`feat:`, `fix:`, `chore:`, `ci:`, `docs:`).
3. Add or update tests for behaviour changes.
4. Open a PR against `main`. CI must be green (lint, format, typecheck, test,
   build, and the 600-LOC size check).

## Coding standards recap

Full detail lives in [`CLAUDE.md`](./CLAUDE.md). The rules CI blocks on:

- No `any`; `unknown` only as input to a Zod `parse`.
- No typecasts (`as`) except `as const` — narrow with Zod or type guards.
- No file over 1000 lines; no PR over 600 LOC.
- Strict, layered module boundaries; clear naming.
