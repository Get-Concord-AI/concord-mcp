# Two-agent overlap demo

This is the canonical Concord demo. It shows two coding agents working in
parallel: Concord flags that they touch the same module **before either PR
exists**, then captures a structured handoff and a review packet.

## Run it

From the repository root:

```bash
pnpm demo
```

This builds the server and runs [`demo.mjs`](./demo.mjs), which drives the real
Concord MCP server over stdio inside a throwaway repo (so it never touches this
project's own `.concord/`).

## What happens

1. **claude-code** claims `TASK-12` (Stripe retry handling, module `billing`).
2. **codex** claims `TASK-14` (invoice totals, module `billing`) — Concord flags
   the overlap on `billing`.
3. **claude-code** hands off `TASK-12` with what changed, tests run, and
   decisions.
4. **claude-code** marks `TASK-12` review-ready with plan, guardrails, open
   questions, and provenance.

The script then prints the generated `.concord/` artifacts, including the full
`REVIEW_PACKET.md`.

## Expected overlap output

```text
Claimed TASK-14 (Fix invoice totals).
Potential overlaps (1):
  - TASK-12 (Add Stripe retry handling): same directory: src/billing; shared module(s): billing
```
