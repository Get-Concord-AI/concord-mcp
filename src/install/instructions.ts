import { RELAYED_MESSAGE_GUIDANCE } from '../domain/pull-inbox.js';
import { renderHarnessMonitorInstructions } from '../domain/harness-config.js';

/** Version of the generated agent workflow contract. */
export const CONCORD_INSTRUCTION_VERSION = '6';

/** Concise MCP-native guidance, versioned with the running server. */
export const CONCORD_SERVER_INSTRUCTIONS = `Concord coordinates coding agents through five workflow tools.
- Call start_work before editing. It registers your agent, claims or accepts the task, and reports overlaps.
- Use inspect_work to read workspace, task, agent, or message context. Use update_work for durable progress or to prompt/reply to another promptable workspace agent, including while that agent is busy.
- Use transfer_work for assignment, acceptance, decline, release, reassignment, evidence-bearing handoff offers, and reopening.
- Call finish_work before finishing, review, or closure with changed files, tests, assumptions, decisions, risks, and provenance.
Keep claims small and resolve reported overlaps before editing.
${RELAYED_MESSAGE_GUIDANCE}`;

/** Canonical fallback block written into supported client instruction files. */
export const CONCORD_INSTRUCTIONS = `## Concord — shared work-state for coding agents

<!-- concord:workflow-version=${CONCORD_INSTRUCTION_VERSION} -->

This project uses Concord MCP. Keep coordination to the five workflow tools:

- **Before editing**, call \`start_work\` with the task, your agent kind, and
  expected files or modules. It registers presence, accepts assigned work when
  appropriate, claims the scope, and returns overlap warnings. Concord derives
  your \`agent_id\` from your session — omit it unless your client told you one.
- Use \`inspect_work\` to read the workspace, one task, one agent, or one message
  thread. Use \`update_work\` for durable progress and for live prompts/replies
  to another promptable workspace agent, including while that agent is busy.
- Use \`transfer_work\` for assignment, acceptance, decline, release,
  reassignment, evidence-bearing handoff offers, and reopening.
- **Before finishing**, call \`finish_work\` once with the outcome, changed
  files, tests, assumptions, decisions, risks, guardrails, and provenance. It
  records evidence and can mark work review-ready or terminal.

Keep each claim small and resolve reported overlaps before editing. Concord
regenerates human-readable review artifacts in \`.concord/\`.

Enforcement remains client-dependent. \`concord doctor\` reports setup and
workflow adoption; optional hooks can block exact-file collisions.

${renderHarnessMonitorInstructions()}`;

/** MDC frontmatter used when creating a fresh Cursor rules file. */
export const CURSOR_MDC_HEADER = `---
description: Concord shared work-state tools for coding agents
alwaysApply: true
---
`;

/** Version of the user-level block written by global mode. */
export const CONCORD_GLOBAL_INSTRUCTION_VERSION = '1';

/**
 * The user-level block global mode writes into each harness's own instruction
 * file. Short, because it loads into every session on the machine, and it
 * defers to a repository's own Concord section where one exists.
 */
export const CONCORD_GLOBAL_INSTRUCTIONS = `## Concord — shared work-state for coding agents

<!-- concord:global-version=${CONCORD_GLOBAL_INSTRUCTION_VERSION} -->

Concord MCP is available in every repository on this machine, including ones
where \`concord setup\` was never run. If the project's own instructions have a
Concord section, follow that instead of this one.

- **Before editing**, call \`start_work\` with the task and the files or modules
  you expect to touch. It registers you, claims them, and reports overlaps with
  other agents; resolve overlaps before editing.
- Use \`inspect_work\` to see who else is here, \`update_work\` for progress and
  messages to other agents, and \`transfer_work\` for handoffs.
- **Before finishing**, call \`finish_work\` with the outcome, changed files,
  and tests.

Outside any repository, work is recorded in the shared \`general\` workspace.
Concord needs no files in the repository: do not run \`concord setup\` yourself.`;
