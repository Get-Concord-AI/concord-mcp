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

## Watch it live

Use two terminals to see the same real MCP activity in the dashboard:

```bash
# Terminal 1
CONCORD_ROOT=$PWD
DEMO_DIR=$(mktemp -d)
git init -q "$DEMO_DIR"
echo "$DEMO_DIR"
pnpm build
(cd "$DEMO_DIR" && node "$CONCORD_ROOT/dist/cli/index.js" dashboard)
```

```bash
# Terminal 2 — replace the path with the DEMO_DIR printed in terminal 1
pnpm demo -- --dir /tmp/your-demo-dir --delay 1000
```

The one-second delay makes agent registration, claims, task memory, overlap,
handoff, and review readiness visible as they happen. The data is not mocked:
both terminals read and write the same local Concord SQLite workspace.

## What happens

1. **claude-code** and **codex** register their live presence.
2. **claude-code** claims `TASK-12` (Stripe retry handling, module `billing`).
3. **codex** claims `TASK-14` (invoice totals, module `billing`) — Concord flags
   the overlap on `billing`.
4. **claude-code** hands off `TASK-12` with what changed, tests run, and
   decisions.
5. **claude-code** marks `TASK-12` review-ready with plan, guardrails, open
   questions, and provenance.

The script then prints the generated `.concord/` artifacts, including the full
`REVIEW_PACKET.md`.

## Expected overlap output

```text
Claimed TASK-14 (Fix invoice totals).
Potential overlaps (1):
  - TASK-12 (Add Stripe retry handling): same directory: src/billing; shared module(s): billing
```
