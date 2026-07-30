/** Version of the generated agent workflow contract. */
export const CONCORD_INSTRUCTION_VERSION = '1';

/** Concise MCP-native guidance, versioned with the running server. */
export const CONCORD_SERVER_INSTRUCTIONS = `Concord coordinates coding agents through five workflow tools.
- Call start_work before editing. It registers your agent, claims or accepts the task, and reports overlaps.
- Use inspect_work to read workspace or task context and update_work for durable progress, decisions, questions, blockers, and findings.
- Use transfer_work for assignment, acceptance, decline, release, reassignment, evidence-bearing handoff offers, and reopening.
- Call finish_work before finishing, review, or closure with changed files, tests, assumptions, decisions, risks, and provenance.
Keep claims small and resolve reported overlaps before editing.`;

/** Canonical fallback block written into supported client instruction files. */
export const CONCORD_INSTRUCTIONS = `## Concord — shared work-state for coding agents

<!-- concord:workflow-version=${CONCORD_INSTRUCTION_VERSION} -->

This project uses Concord MCP. Keep coordination to the five workflow tools:

- **Before editing**, call \`start_work\` with the task, your agent kind/id, and
  expected files or modules. It registers presence, accepts assigned work when
  appropriate, claims the scope, and returns overlap warnings.
- Use \`inspect_work\` to read the workspace or one task. Use \`update_work\` for
  durable progress, decisions, assumptions, questions, blockers, and findings.
- Use \`transfer_work\` for assignment, acceptance, decline, release,
  reassignment, evidence-bearing handoff offers, and reopening.
- **Before finishing**, call \`finish_work\` once with the outcome, changed
  files, tests, assumptions, decisions, risks, guardrails, and provenance. It
  records evidence and can mark work review-ready or terminal.

Keep each claim small and resolve reported overlaps before editing. Concord
regenerates human-readable review artifacts in \`.concord/\`.

Enforcement remains client-dependent. \`concord doctor\` reports setup and
workflow adoption; optional hooks can block exact-file collisions.`;

/** MDC frontmatter used when creating a fresh Cursor rules file. */
export const CURSOR_MDC_HEADER = `---
description: Concord shared work-state tools for coding agents
alwaysApply: true
---
`;
