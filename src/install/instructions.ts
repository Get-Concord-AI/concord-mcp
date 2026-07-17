/** The canonical instruction block written into each client's config. */
export const CONCORD_INSTRUCTIONS = `## Concord — shared work-state for coding agents

This project uses Concord MCP. Use its tools so your work is visible before PRs:

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
shows per-task adoption either way.`;

/** MDC frontmatter used when creating a fresh Cursor rules file. */
export const CURSOR_MDC_HEADER = `---
description: Concord shared work-state tools for coding agents
alwaysApply: true
---
`;
