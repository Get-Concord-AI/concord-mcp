# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Get-Concord-AI/concord-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Get-Concord-AI/concord-mcp/releases/tag/v0.1.0
