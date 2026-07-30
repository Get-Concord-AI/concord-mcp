# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Get-Concord-AI/concord-mcp/releases/tag/v0.1.0
