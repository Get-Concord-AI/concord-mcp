# Why not just use markdown?

Lots of teams already hand-write `AGENTS.md`, handoff notes, and review checklists
for their coding agents. That's a great instinct — Concord is what those files
grow into.

Markdown handoff files are:

- **Unstructured** — every agent and person writes them differently, so nothing
  can query or check them.
- **Invisible until PR time** — a file in one agent's branch doesn't warn another
  agent that they're about to touch the same module.
- **Easy to skip** — with no record of whether they were written, there's no way
  to tell adoption from good intentions.

Concord keeps the good parts and fixes those gaps:

- **Structured** — agents record work through `claim_work`, `handoff`, and
  `review_ready`, so the data is consistent and queryable.
- **Shared early** — `claim_work` flags overlaps between active tasks before
  either PR exists.
- **Visible to humans** — Concord still produces `HANDOFF.md` and
  `REVIEW_PACKET.md` you can commit and read in a PR.
- **Measurable** — `concord doctor` shows which tools each task actually used, so
  skipping is visible.

You keep writing markdown — Concord just makes it structured, queryable, and hard
to skip.
