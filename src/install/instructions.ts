/** The canonical instruction block written into each client's config. */
export const CONCORD_INSTRUCTIONS = `## Concord — shared work-state for coding agents

This project uses Concord MCP. Use its tools so your work is visible before PRs:

- **Keep each claim small.** Break work into the smallest independently
  handoff-able unit and \`claim_work\` each piece separately, rather than
  claiming one broad task. Concord flags claims that look too broad.
- **Before editing code**, call \`claim_work\` with the task id, title, and the
  files/modules you expect to touch. Concord warns about overlaps with other
  active work.
- **Before finishing or when blocked**, call \`handoff\` with what changed, tests
  run, assumptions, decisions, and guardrails you checked.
- **Before opening a PR**, call \`review_ready\` with a plan summary, tests, open
  questions, and provenance.

Concord regenerates human-readable \`HANDOFF.md\` and \`REVIEW_PACKET.md\` in
\`.concord/\` so humans can review your work.

Enforcement note: on clients with hooks/command registration this can be
enforced; elsewhere it is instruction-based and may be skipped. \`concord doctor\`
shows per-task adoption either way. For edit-time enforcement, wire a PreToolUse
(or git pre-commit) hook to \`concord check <files> --task <your-task-id>\`; it
exits non-zero when your edits collide with another agent's active claim.`;

/** MDC frontmatter used when creating a fresh Cursor rules file. */
export const CURSOR_MDC_HEADER = `---
description: Concord shared work-state tools for coding agents
alwaysApply: true
---
`;
