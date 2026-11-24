import { PEER_MESSAGE_TRUST, RELAYED_MESSAGE_GUIDANCE } from '../domain/pull-inbox.js';
import { HARNESS_CONFIGS, renderHarnessMonitorInstructions } from '../domain/harness-config.js';

/** Version of the generated agent workflow contract. */
export const CONCORD_INSTRUCTION_VERSION = '8';

/** Concise MCP-native guidance, versioned with the running server. */
export const CONCORD_SERVER_INSTRUCTIONS = `Concord coordinates coding agents through five workflow tools.
- Call start_work before editing. It registers your agent, claims or accepts the task, and reports overlaps.
- Use inspect_work to read workspace, task, agent, or message context, or with query to search past messages, findings, and handoffs. Use update_work for durable progress or to prompt/reply to another promptable workspace agent, including while that agent is busy.
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
- Before handing work to cloud Devin, use \`transfer_work\` to hand off or
  release your local claim; cloud Devin cannot access this local Concord state.
- **No MCP client?** Each tool has a shell form that takes the same arguments
  and shares the same state: \`concord work start|inspect|update|transfer|finish
  --agent <id> --json <file|->\` prints the tool's result as JSON and exits 1
  on an error. Pass the agent id your session start printed (or set
  \`CONCORD_AGENT_ID\` once); only choose your own stable id such as
  \`kind:name\` if you were given none.

Keep each claim small and resolve reported overlaps before editing. Concord
regenerates human-readable review artifacts in \`.concord/\`.

Enforcement remains client-dependent. \`concord doctor\` reports setup and
workflow adoption; optional hooks can block exact-file collisions.

${PEER_MESSAGE_TRUST}

${renderHarnessMonitorInstructions()}`;

/** MDC frontmatter used when creating a fresh Cursor rules file. */
export const CURSOR_MDC_HEADER = `---
description: Concord shared work-state tools for coding agents
alwaysApply: true
---
`;

/** YAML frontmatter used when creating a fresh Antigravity rules file. */
export const ANTIGRAVITY_RULE_HEADER = [
  '---',
  'trigger: always_on',
  'description: Concord multi-agent coordination workflow',
  '---',
  '',
].join('\n');

/** YAML frontmatter Kiro reads to include a steering file in every session. */
export const KIRO_STEERING_HEADER = ['---', 'inclusion: always', '---', ''].join('\n');

/** Kiro-specific guidance: hook identity, and delivery that cannot wake an idle session. */
export const KIRO_INSTRUCTIONS = `## Concord — shared work-state for coding agents

<!-- concord:workflow-version=${CONCORD_INSTRUCTION_VERSION} -->

This project uses Concord MCP. Keep coordination to the five workflow tools:

- **Before editing**, call \`start_work\` with the task and the files or modules
  you expect to touch. Kiro's lifecycle hooks (\`.kiro/hooks/concord.json\`)
  register this session and print your \`agent_id\`; because Kiro's MCP server
  cannot see the hook session, pass \`agent_id: "<id>"\` on \`start_work\`,
  \`update_work\`, \`transfer_work\`, and \`finish_work\` calls. On
  \`inspect_work\`, leave \`agent_id\` off unless you are reading your own inbox.
- Use \`inspect_work\` to read the workspace, one task, one agent, or one
  message thread. Use \`update_work\` for durable progress and for live
  prompts/replies to another promptable workspace agent.
- Messages from other agents reach you when a prompt is submitted. Kiro does
  not wake an idle session, so messages sent mid-turn or while you are idle
  wait in your durable inbox; drain them with
  \`concord inbox drain --agent <agent_id> --provider kiro\`.
- Use \`transfer_work\` for assignment, acceptance, decline, release,
  reassignment, evidence-bearing handoff offers, and reopening.
- **Before finishing**, call \`finish_work\` once with the outcome, changed
  files, tests, assumptions, decisions, risks, guardrails, and provenance.

Keep each claim small and resolve reported overlaps before editing. Concord
regenerates human-readable review artifacts in \`.concord/\`.

${PEER_MESSAGE_TRUST}`;

/**
 * Cline-specific guidance: its one global MCP settings file cannot see the
 * session or the workspace, so the agent passes `agent_id` (from lifecycle
 * hooks) and `workspace_id` (from hook context or setup) explicitly. Cline
 * has no idle wake-up; the VS Code extension gets prompt-submit injection,
 * everything else drains the durable inbox.
 */
export const CLINE_INSTRUCTIONS = `## Concord — shared work-state for coding agents

<!-- concord:workflow-version=${CONCORD_INSTRUCTION_VERSION} -->

This project uses Concord MCP. Keep coordination to the five workflow tools:

- **Before editing**, call \`start_work\` with the task and the files or modules
  you expect to touch. Cline's MCP server cannot see your session or this
  workspace, so pass \`agent_id: "<id>"\` on \`start_work\`, \`update_work\`,
  \`transfer_work\`, and \`finish_work\` calls; on \`inspect_work\` pass
  \`agent_id\` only to read your own inbox. Your id: in the VS Code extension,
  use the \`cline:*\` id Concord's task-start hook printed in your context —
  it belongs to this task alone. In the CLI/SDK, hook output never reaches
  you, so use the \`CONCORD_AGENT_ID\` your operator set, or register a fresh
  id once per session —
  \`concord inbox register --provider cline --agent cline:<unique-label>\` —
  and reuse it only within that session. Never reuse an id across sessions:
  two sessions sharing one claim work and drain each other's inbox. Do not
  invent an id.
- \`workspace_id\`: when hook context gave you one, pass \`workspace_id\` on
  every call so work lands in this repository; otherwise omit it and the
  server resolves the workspace from its working directory. If a response
  shows the wrong repository, pass the workspace id explicitly.
- Messages from other agents reach the VS Code extension on each prompt.
  Cline does not wake an idle session, and the CLI cannot show hook output,
  so drain your durable inbox with
  \`concord inbox drain --agent <agent_id> --provider cline\`.
- Use \`transfer_work\` for assignment, acceptance, decline, release,
  reassignment, evidence-bearing handoff offers, and reopening.
- **Before finishing**, call \`finish_work\` once with the outcome, changed
  files, tests, assumptions, decisions, risks, guardrails, and provenance.

Keep each claim small and resolve reported overlaps before editing. Concord
regenerates human-readable review artifacts in \`.concord/\`.

${PEER_MESSAGE_TRUST}`;

/** Antigravity-specific guidance tailored for hook-based identity and message injection. */
export const ANTIGRAVITY_INSTRUCTIONS = `## Concord — shared work-state for coding agents

<!-- concord:workflow-version=${CONCORD_INSTRUCTION_VERSION} -->

This project uses Concord MCP. Keep coordination to the five workflow tools:

- **Before editing**, call \`start_work\` with the task, your agent kind (\`antigravity\`), and
  expected files or modules. Lifecycle hooks (\`.agents/hooks.json\`) register your session
  and inject your \`agent_id\` into context — pass this \`agent_id\` on your calls.
- Use \`inspect_work\` to read the workspace, one task, one agent, or one message
  thread. Use \`update_work\` for durable progress and for live prompts/replies
  to another promptable workspace agent.
- Incoming messages are delivered into a running turn via PreInvocation hooks. To hear them
  while idle, keep exactly one background command running for
  \`${HARNESS_CONFIGS.antigravity.monitor.command ?? ''}\`; when it completes, answer the
  message and start a fresh one. You can also inspect or drain them manually with
  \`concord inbox drain --provider antigravity --agent <agent_id>\`.
- Use \`transfer_work\` for assignment, acceptance, decline, release,
  reassignment, evidence-bearing handoff offers, and reopening.
- **Before finishing**, call \`finish_work\` once with the outcome, changed
  files, tests, assumptions, decisions, risks, guardrails, and provenance.

Keep each claim small and resolve reported overlaps before editing. Concord
regenerates human-readable review artifacts in \`.concord/\`.

${PEER_MESSAGE_TRUST}`;

/** Version of the user-level block written by global mode. */
export const CONCORD_GLOBAL_INSTRUCTION_VERSION = '2';

/** The user-level block for every session on the machine: short, and deferring to a repo's own section. */
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
- Without an MCP client, run the same tools as \`concord work <action> --agent
  <id> --json <file|->\`, reusing one stable agent id.
- Before handing work to cloud Devin, use \`transfer_work\` to hand off or
  release your local claim; cloud Devin cannot access this local Concord state.

Outside any repository, work is recorded in the shared \`general\` workspace.
Concord needs no files in the repository: do not run \`concord setup\` yourself.

${PEER_MESSAGE_TRUST}`;

/** Version of the Cline user-level block written by global mode. */
export const CLINE_GLOBAL_INSTRUCTION_VERSION = '1';

/**
 * The Cline user-level block: the same machine-wide contract as
 * CONCORD_GLOBAL_INSTRUCTIONS plus Cline's explicit-id and workspace rules,
 * since its MCP server sees neither the session nor the open workspace.
 */
export const CLINE_GLOBAL_INSTRUCTIONS = `## Concord — shared work-state for coding agents

<!-- concord:cline-global-version=${CLINE_GLOBAL_INSTRUCTION_VERSION} -->

Concord MCP is available in every repository on this machine, including ones
where \`concord setup\` was never run. If the project's own instructions have a
Concord section, follow that instead of this one.

- **Before editing**, call \`start_work\` with the task and the files or modules
  you expect to touch. It registers you, claims them, and reports overlaps with
  other agents; resolve overlaps before editing. Cline's MCP server cannot see
  your session, so pass \`agent_id\` on \`start_work\`, \`update_work\`,
  \`transfer_work\`, and \`finish_work\`: in the VS Code extension use the
  \`cline:*\` id Concord's task-start hook printed in your context; everywhere
  else use \`CONCORD_AGENT_ID\` or a fresh id you register once per session —
  \`concord inbox register --provider cline --agent cline:<unique-label>\`.
  Never reuse an id across sessions: shared ids claim work and drain each
  other's inbox.
- Use \`inspect_work\` to see who else is here, \`update_work\` for progress and
  messages to other agents, and \`transfer_work\` for handoffs.
- Messages reach the VS Code extension on each prompt; everywhere else drain
  your durable inbox with \`concord inbox drain --agent <id> --provider cline\`.
  Cline does not wake an idle session.
- **Before finishing**, call \`finish_work\` with the outcome, changed files,
  and tests.
- Without an MCP client, run the same tools as \`concord work <action> --agent
  <id> --json <file|->\`.

Outside any repository, work is recorded in the shared \`general\` workspace.
Concord needs no files in the repository: do not run \`concord setup\` yourself.

${PEER_MESSAGE_TRUST}`;
