# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Ownerless tasks are no longer permanently stranded when their claiming
  session ends: an owner-registered agent may now `force`-reassign or reopen an
  ownerless task once the claimant's derived liveness decays past idle.
  Owned tasks keep strict same-owner arbitration; live claims and rescuers
  without a registered human owner are still refused.
- `start_work` calls that name no `owner` now default it from
  `CONCORD_DEFAULT_OWNER`, else the repository's `git config user.name`, so new
  tasks are no longer created ownerless. An explicit `owner` always wins.

## [0.10.3] - 2026-08-25

### Added

- `finish_work` can now record an optional, source-labelled task outcome with
  acceptance, integration, intervention, and rework results. Reported outcomes
  are persisted and included in local handoff and review artifacts.
- Telemetry now records semantic outcomes for overlap warnings, edit guards,
  message delivery, task lifecycle, and reported results. Task flows use
  installation-scoped pseudonyms; raw task ids, paths, messages, and tool
  payloads are not sent.

### Fixed

- Idempotent message retries no longer duplicate unchanged delivery events, and
  asynchronous delivery events remain attributed to the workspace where the
  operation began.

## [0.10.2] - 2026-08-24

### Added

- Background MCP sessions now check npm without blocking startup or tool calls,
  then surface the update prompt through the next tool result. Users who rarely
  invoke the interactive CLI are still told when a newer release is available,
  and the live dashboard keeps the command visible in a yellow banner.
- Interactive `concord setup` now checks for an available release before
  changing configuration and offers a default-No upgrade prompt. An accepted
  upgrade stops setup and asks the user to rerun it with the new version.

### Fixed

- The npm `/latest` request now uses an accepted JSON media type. The previous
  abbreviated-metadata header received HTTP 406 and silently cached a failed
  check instead of detecting the published version.

## [0.9.0] - 2026-08-14

Agents that walked away hours ago no longer crowd the roster. Presence decayed
as far as `away` and stopped there, so every agent that ever registered stayed
listed forever: a workspace roster only grew, and the agents actually present
were buried among sessions that ended days earlier.

### Added

- `archived`, a fourth derived liveness tier after `live`, `idle`, and `away`,
  reached an hour after an agent was last seen. Archived agents are left out of
  the roster `buildRoster` returns, which is the single place every presence
  surface reads — so they disappear from the `concord dashboard` agents panel,
  `concord who`, `concord status`, the `get_work_state` tool and
  `concord://work-state` resource, the SessionStart hook's "who else is here",
  and `WORK_STATE.json` at once.

### Changed

- Nothing is deleted. An agent id keeps its registration, history, and claims,
  so an archived agent that comes back is live again on its next heartbeat.
  Archiving is a display state derived from `last_seen` like the rest of
  liveness, so there is no schema change and no migration.
- Stale-claim detection still sees archived agents. An active claim left behind
  by a long-gone agent stays flagged rather than vanishing with its owner.
- An unparseable `last_seen` now derives `archived` rather than `away`. A
  corrupt timestamp previously pinned that agent to the roster permanently,
  which is the situation archiving exists to prevent.

## [0.8.0] - 2026-08-10

An agent's identity is now derived from its session in one place, instead of
being minted separately by each entry point. Three producers of `agent_id`
disagreed: the relay CLI and the SessionStart hooks derived it from the session
id, while the MCP surface generated a random one. Only the CLI writes delivery
endpoints, so an agent that let `start_work` name it received an identity no
endpoint would ever match — present in the roster, addressable by peers, and
permanently undeliverable. In one workspace, 23 of 24 such agents had no
endpoint at all, and every message sent to them failed `target_not_promptable`.

### Changed

- **Concord resolves `agent_id` from the session, and that resolution wins.**
  A supplied `agent_id` is ignored wherever the session is visible, so an agent
  can no longer claim, finish, or send messages as one of its peers. The field
  stays on the tool surface for clients whose session Concord cannot see: Codex
  spawns MCP servers with a scrubbed environment — no session id, not even
  `PWD` — so its SessionStart hook still tells the model which id to pass back.
- `agent_id` is now optional on `transfer_work` and `finish_work`, which
  previously required it.
- The MCP server registers its presence at startup, before the transport
  connects, deriving its identity from the session id already in its
  environment. Presence no longer waits for the model to call a tool.

### Removed

- Generated agent ids. Where identity cannot be resolved, tools now fail with
  instructions for fixing it rather than registering an unreachable agent.

### Fixed

- **Messages addressed to an agent that entered through `start_work` are
  delivered.** The relay and the MCP surface now agree on one id per session, so
  a peer's reply reaches the agent that asked for it.
- A Codex hook whose payload carried no session id fell back to
  `CLAUDE_CODE_SESSION_ID` and registered `codex:<hash of a Claude session>`, an
  id belonging to no session. Each client's kind and session id are now read
  from the same source.
- Task-scoped activity now refreshes the task's `updated_at` timestamp, so
  current-state views reflect reclaims, progress updates, task-scoped messages,
  handoffs, reviews, and lifecycle work independently of agent heartbeat.
  Activity refreshes do not increment the optimistic-concurrency version.
- Claim metadata fields reject serialized tool-parameter markup, so a client
  that folds later arguments into an earlier free-text field cannot create a
  claim without its real `expected_files`, `modules`, and `domains`.

## [0.7.1] - 2026-08-06

### Fixed

- The relay plugin is now published. `files` listed only `dist`, so 0.7.0 on
  npm contained the CLI and server but not `plugin/concord-relay` — the
  background monitor is the only channel that reaches an idle Claude Code
  agent, and it was unavailable to anyone who installed from the registry.
- `concord setup` installs it. Codex hooks were installed automatically while
  Claude Code's half of the relay was left to be wired up by hand, so a fresh
  setup gave Codex live delivery and Claude Code none. A monitor can only be
  declared by a plugin, so this links the packaged plugin into Claude Code's
  skills directory, where it loads with no marketplace and no install step.

## [0.7.0] - 2026-08-06

Inter-agent messages are now actually delivered. 0.6.1 shipped the send path but
nothing on the other end: `update_work operation="prompt"` failed with
`Concord relay is not connected`, because the relay assumed an external process
could push a prompt into a session another process is already running. No coding
agent exposes that — `claude inject` and `codex inject` are both closed
unimplemented. The recipient now pulls instead.

### Added

- A pull transport. A send enqueues a pending message; the recipient drains its
  own inbox from inside its session, and delivery is recorded at drain time, so
  `delivered` means the agent was actually handed the message.
- `concord inbox` (`status`, `register`, `drain`) — the receiving half, invoked
  by client hooks rather than by hand.
- A Claude Code plugin under `plugin/concord-relay`. Its background monitor is
  the only channel that reaches an agent sitting idle at the prompt; the
  `PostToolUse` and `Stop` hooks cover headless `-p` runs, where monitors do not
  run.
- Codex lifecycle hooks, installed by `concord setup`. Codex has the same hook
  surface as Claude Code but no monitor equivalent, so an idle Codex session
  does not see a queued message until its next turn.
- Endpoints carry real reach (`busy`, `idle`), and `update_work` reports it back
  so a sender is told when a message will sit unread rather than assuming it
  landed.
- Sessions identify themselves with no configuration, from
  `CLAUDE_CODE_SESSION_ID` or a Codex hook payload. `CONCORD_AGENT_ID` still
  overrides it when a human wants to name the agents they are coordinating.

### Changed

- Relayed messages are framed as peer information rather than instructions, and
  that framing is stated once in the server instructions instead of on every
  delivery — it had been costing roughly 24x the payload of a short message.
- `concord setup` warns that Codex skips untrusted hooks silently until you run
  `/hooks` once and trust them.

### Removed

- **Breaking:** the `@concord-ai/concord-mcp/relay` entry point, along with the
  socket relay server, wire protocol, credential handshake, and the Claude and
  Cursor session adapters. They targeted APIs that do not exist. Delivery now
  routes on `agent_endpoints.transport` instead of a dispatcher.
- The `--agent-comms` setup flag and `agent-integrations.json`, which existed
  only to approve that relay.

### Fixed

- `concord setup` no longer wipes Codex hook trust. Codex appends
  `[hooks.state]` trust hashes to the end of `config.toml`, which landed inside
  Concord's marker block; rewriting it silently re-prompted for trust, and until
  granted Codex skipped the hooks without saying so.
- Agent ids no longer collide. They truncated the session id to eight
  characters, but Codex ids are UUIDv7 whose leading hex is a millisecond clock
  — the first eight characters advance only once per ~65 seconds, so two Codex
  sessions started in the same minute shared an id and an inbox.
- A message is never delivered twice. Draining now claims each row atomically,
  which matters because a Claude Code session drains from a monitor poll and a
  tool-result hook at the same time.
- The relay monitor exits immediately outside a Concord workspace instead of
  polling for the life of an unrelated project.

## [0.6.1] - 2026-07-31

### Added

- Live agent-to-agent prompts and explicit replies through the existing
  `update_work` tool, with agent inbox and durable message-thread inspection
  through `inspect_work`.
- Expiring local relay endpoints, authenticated socket delivery, idempotent
  retries, delivery receipts, and append-only message events.
- Codex, Claude, and Cursor host adapter contracts exported from
  `@concord-ai/concord-mcp/relay`, including a public workspace entry point for
  installed client integrations.

### Changed

- `concord setup` now combines workspace initialization, client instructions,
  repository-pinned MCP registration, and optional live-prompt integration
  approval. It replaces the separate `concord init` and `concord install`
  commands.
- Busy prompt targets are steered immediately and idle targets start a new
  turn. Unreachable named targets fail without suggestions or automatic
  rerouting.

## [0.6.0] - 2026-07-30

### Added

- Five public workflow tools — `start_work`, `inspect_work`, `update_work`,
  `transfer_work`, and `finish_work` — replace the granular MCP lifecycle
  surface. The server now supplies concise workflow instructions directly, and
  `concord doctor` identifies generated instruction blocks that need refreshing.
- `concord install` now registers the MCP server itself, writing `.mcp.json`
  (Claude Code), `.cursor/mcp.json` (Cursor), and `[mcp_servers.concord]` in
  Codex's `~/.codex/config.toml` (honoring `CODEX_HOME`). Previously it wrote
  only the agent instructions, leaving registration as a manual step that was
  easy to miss — the instructions landed but the tools were never connected.
  Existing servers, unrelated keys, and TOML comments are preserved, and
  re-running is a no-op. Pass `--no-mcp` to skip registration. A config file
  that cannot be parsed is reported and left untouched rather than overwritten.

### Removed

- The earlier granular MCP tool names are no longer registered as public
  aliases. Update Concord and re-run `concord install` to migrate local agent
  instructions.
- Dormant granular tool schemas, registration adapters, and presentation
  helpers were removed; internal lifecycle operations derive their types from
  the five workflow contracts.

## [0.5.0] - 2026-07-28

### Added

- Transparent, default-on anonymous telemetry for MCP tool and CLI command
  adoption, outcomes, and duration, with stable pseudonymous installation and
  workspace identities.
- `CONCORD_TELEMETRY_DISABLED=1` and `DO_NOT_TRACK=1` opt-outs.

### Security

- Telemetry excludes code, paths, repository remotes, usernames, task and agent
  identifiers, command arguments, tool inputs/outputs, and task content.

## [0.4.1] - 2026-07-26

### Added

- Interactive CLI commands now show a cached, best-effort notice when a newer
  stable Concord release is available on npm.

### Fixed

- `concord dashboard` now uses a bounded full-screen viewport and alternate
  screen buffer, preventing refresh frames from accumulating in terminal
  scrollback.

## [0.4.0] - 2026-07-26

### Added

- Agent presence registry with the `register_agent` MCP tool, derived
  live/idle/away states, `concord who`, and stale-claim detection.
- `concord dashboard`, a live read-only TUI for agents, tasks, coordination
  alerts, task memory, handoffs, review state, and recent activity.
- A paced two-terminal demo that shows real MCP activity appearing in the
  dashboard.

### Changed

- Claude Code sessions can auto-register their presence through the
  `SessionStart` hook, and normal write-tool activity refreshes agent presence.
- The MCP server resolves its shared store at the repository root so agents
  started from different working directories converge on one workspace.

## [0.3.0] - 2026-07-23

### Added

- Task-scoped memory with typed `update_task` entries for intent, progress,
  assumptions, decisions, questions, answers, blockers, and findings.
- `get_task_context` for reading a task's ordered updates, latest handoff and
  review evidence, and current overlap warnings.

## [0.2.0] - 2026-07-22

### Added

- Read-only work-state tool and resource, change notifications, overlap
  enforcement commands, task decomposition, and normalized overlap matching.

### Changed

- Review readiness is now part of `handoff` via `ready_for_review`.

## [0.1.1]

### Changed

- First release published via the automated GitHub Actions pipeline (npm trusted
  publishing / OIDC). No functional changes from 0.1.0.

## [0.1.0]

### Added

- MCP server with the three v0 tools: `claim_work` (with overlap detection),
  `handoff`, and `review_ready`.
- SQLite storage (source of truth) with migrations and typed repositories.
- Rendered artifacts: `HANDOFF.md`, `REVIEW_PACKET.md`, `WORK_STATE.json`, and
  `events.jsonl`, regenerated on every tool write.
- `concord` CLI: `init`, `status`, `tasks`, `handoff`, `review-packet`,
  `export`, `doctor`, and `install`.
- `concord install` writes usage instructions for Claude Code, Codex, and Cursor.
- Two-agent overlap demo (`pnpm demo`).

[Unreleased]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.10.3...HEAD
[0.10.3]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.10.2...v0.10.3
[0.10.2]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.10.1...v0.10.2
[0.9.0]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Get-Concord-AI/concord-mcp/releases/tag/v0.1.0
