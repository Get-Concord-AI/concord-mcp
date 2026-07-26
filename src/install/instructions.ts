/** The canonical instruction block written into each client's config. */
export const CONCORD_INSTRUCTIONS = `## Concord — shared work-state for coding agents

This project uses Concord MCP. Use its tools so your work is visible before PRs:

- **At session start, call \`register_agent\`** with your kind (e.g. claude-code),
  a one-line summary of what you are working on, and your status. Reuse the
  returned \`agent_id\` on every later Concord call so your presence stays
  attributed to one instance, and call \`register_agent\` again when your focus
  changes. Then call \`get_work_state\` to see who else is active before you
  start — it shows the agent roster, active claims, overlaps, and stale claims.
- **Keep each claim small.** Break work into the smallest independently
  handoff-able unit and \`claim_work\` each piece separately, rather than
  claiming one broad task. Concord flags claims that look too broad.
- **Before editing code**, call \`claim_work\` with the task id, title, your
  \`agent_id\`, and the files/modules you expect to touch. Concord warns about
  overlaps with other active work.
- **While working**, call \`update_task\` (with your \`agent_id\`) for durable
  intent, progress, assumptions, decisions, questions, answers, blockers, and
  findings. When resuming or coordinating on a task, call \`get_task_context\`
  first.
- **Before finishing or when blocked**, call \`handoff\` with what changed, tests
  run, assumptions, decisions, and guardrails you checked. **Before a PR**, set
  \`ready_for_review\` (with open questions and provenance) to also produce a
  review packet.

Concord regenerates human-readable \`HANDOFF.md\` and \`REVIEW_PACKET.md\` in
\`.concord/\` so humans can review your work.

Enforcement note: on clients with hooks/command registration this can be
enforced; elsewhere it is instruction-based and may be skipped. \`concord doctor\`
shows per-task adoption either way. For edit-time enforcement, wire a PreToolUse
(or git pre-commit) hook to \`concord check <files> --task <your-task-id>\`; it
exits non-zero when your edits collide with another agent's active claim. On
Claude Code, \`concord install --claude-hooks\` installs this automatically — set
\`CONCORD_TASK=<your task id>\` so the hook excludes your own claim.`;

/** MDC frontmatter used when creating a fresh Cursor rules file. */
export const CURSOR_MDC_HEADER = `---
description: Concord shared work-state tools for coding agents
alwaysApply: true
---
`;
