<p align="center">
  <a href="https://getconcord.ai">
    <img src="./assets/concord-readme-header.png" alt="Concord MCP — shared work-state for coding agents" width="100%">
  </a>
</p>

<h1 align="center">Concord MCP</h1>

<p align="center"><strong>Let Claude Code, Codex, Cursor, Gemini CLI, and Grok Build talk to each other.</strong></p>

<p align="center">
  The open-source, local-first communication and coordination layer for AI coding agents.
  Send live messages across harnesses, detect overlapping work before agents edit,
  share decisions, and hand off tasks with evidence - through one MCP server.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@concord-ai/concord-mcp"><img src="https://img.shields.io/npm/v/@concord-ai/concord-mcp.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@concord-ai/concord-mcp"><img src="https://img.shields.io/npm/dm/@concord-ai/concord-mcp.svg" alt="npm downloads"></a>
  <a href="https://github.com/Get-Concord-AI/concord-mcp/actions/workflows/ci.yml"><img src="https://github.com/Get-Concord-AI/concord-mcp/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@concord-ai/concord-mcp"><img src="https://img.shields.io/node/v/@concord-ai/concord-mcp.svg" alt="Node.js version"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License"></a>
</p>

<p align="center">
  <a href="#see-it-work">Demo</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#supported-agents">Supported agents</a> ·
  <a href="https://getconcord.ai">Website</a> ·
  <a href="./CONTRIBUTING.md">Contributing</a>
</p>

## See it work

Two agents in different harnesses can discover each other, exchange messages,
and divide work without a human relaying context between them:

```text
Claude Code → Concord   Claim src/app/page.tsx
Codex       → Concord   Claim src/app/page.tsx
Concord     → Codex     Overlap: Claude Code already owns this file
Codex       → Claude    I'll take src/app/api instead. Does that work?
Claude      → Codex     Yes. I'll keep the page and use your API contract.
```

Run the [real Claude Code ↔ Codex demo](./examples/whack-a-mole/) to watch both
agents resolve an overlapping claim through a live prompt/reply, build a playable
app, transfer ownership, and hand the result to an independent reviewer.

## Quick start

```bash
npm install -g @concord-ai/concord-mcp
cd /path/to/your/repository
concord setup
```

Restart your agent clients, then ask two of them to work in the same repository.
Concord gives them a shared workspace and makes reachable sessions available for
direct prompts and replies.

<details>
<summary>What <code>concord setup</code> changes</summary>

`concord setup` creates the local `.concord/` workspace, registers the MCP server
for Claude, Cursor, Gemini, Grok, and Codex (`.mcp.json`, `.cursor/mcp.json`,
`.gemini/settings.json`, `.grok/config.toml`, and `~/.codex/config.toml`) and writes
Concord's tool instructions into your client configs (`CLAUDE.md`, `AGENTS.md`,
`.codex/`, `.cursor/rules/`). It merges into existing config rather than replacing
it and is safe to re-run.

Setup also detects supported clients and attempts to install their global Concord
adapters independently. Use `--no-adapters` to skip that step or
`--require-adapters` in managed installs that should fail on degraded support.
Pass `--no-mcp` to write only the workspace and instructions while managing MCP
registration yourself.

</details>

## Supported agents

| Agent                              | Integration guide                            |
| ---------------------------------- | -------------------------------------------- |
| Claude Code                        | [Setup and delivery](./docs/claude-code.md)  |
| Codex                              | [Setup and delivery](./docs/codex.md)        |
| Cursor                             | [Setup and delivery](./docs/cursor.md)       |
| Gemini CLI                         | [Setup and delivery](./docs/gemini-cli.md)   |
| Grok Build                         | [Setup and delivery](./docs/grok-build.md)   |
| Any other MCP-capable coding agent | Shared work-state through the five MCP tools |

> There is no universal `/concord` slash command — commands are client-specific.
> Concord works through MCP tools plus the installed instructions on any
> MCP-capable client.

Live delivery depends on the receiving harness and session state. Run
`concord adapters status` to see which installed agents are reachable and how
messages will be delivered.

## Communication is the starting point

Messaging gets agents talking. Concord's shared work-state keeps the resulting
collaboration reliable after the message is delivered.

| Without Concord                                     | With Concord                                                   |
| --------------------------------------------------- | -------------------------------------------------------------- |
| Agents cannot contact peers in another harness      | Agents send direct, replyable prompts across supported clients |
| Agents discover collisions after editing            | Agents claim files and modules before work begins              |
| Context disappears when a session ends              | Decisions, assumptions, and findings stay attached to the task |
| Ownership is implied by chat history                | Assignments and handoffs are explicit and acknowledged         |
| Humans reconstruct progress from branches and diffs | Review packets arrive with scope, tests, risks, and provenance |

Concord is not another autonomous agent or orchestrator. It is the shared layer
around your agents: presence, messaging, task memory, ownership, handoffs, and
review state through one small MCP server.

## The tools

| Tool            | Purpose                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------- |
| `start_work`    | registers presence, claims or accepts one task, and reports scope overlaps before editing   |
| `inspect_work`  | reads workspace/task state, an agent inbox/outbox, or a durable prompt/reply thread         |
| `update_work`   | records task context or immediately prompts/replies to another promptable workspace agent   |
| `transfer_work` | assigns, accepts, declines, releases, reassigns, offers handoffs, or reopens versioned work |
| `finish_work`   | records evidence and optionally marks a task review-ready, complete, or closed              |

Writes accept an `agent_id`, which keeps presence live just by working.
`inspect_work` shows **who is here** and flags **stale claims** — an active
claim whose owning agent has gone away without handing off.

For live agent-to-agent communication, run `concord setup`, then restart existing
client sessions once. A prompt uses `update_work` with `operation: "prompt"`, the
target `to_agent_id`, content, and an `idempotency_key`; a reply uses
`operation: "reply"` and `reply_to_message_id`. A receipt-bearing adapter steers
a busy turn or starts an idle turn. Hook-only integrations leave a durable pull
message and state that limitation in the result. Delivery fails immediately
when the named agent has no reachable endpoint; Concord does not silently
reroute it.

`concord adapters status` reports each harness separately, including its
monitor/controller kind, verified reachability, required action, and version
probe result. `concord adapters install`, `doctor`, and `uninstall` provide the
same global lifecycle outside repository setup.

Concord resolves the repository workspace automatically. Operations return its
`workspace_id` and repository root so a client can detect a misrouted call; the
id can be passed explicitly when one server is coordinating multiple roots.

Lifecycle-changing operations use the task's monotonic `version` as
`expected_version`. If two agents act on the same version, only the first
transition succeeds. Assignment leaves work in `assigned` until the named agent
uses `transfer_work` with `action: "accept"`; a handoff offer likewise keeps
ownership with the sender until the recipient accepts. Every ownership change
is retained in an append-only audit history.

## What you get

SQLite is the local source of truth, kept in the `.concord/` at the **root of
the repo** the work is happening in. The MCP server resolves that root from
`CONCORD_REPO_ROOT` if set, then Claude Code's `CLAUDE_PROJECT_DIR` (which Claude
Code sets automatically, even for a user-scoped server), then its working
directory — so every agent in one repo shares one store. Set `CONCORD_REPO_ROOT`
when running the server somewhere its working directory is not inside the repo.

Linked Git worktrees follow Git's `commondir` metadata to the primary checkout,
so the main checkout and all linked worktrees intentionally share one Concord
database and workspace id.

To restrict explicit workspace selection, set `CONCORD_ALLOWED_ROOTS` to a
path-delimited list of allowed repository roots. Without an allowlist, decoded
roots must still exist and be directories.

`concord setup` writes a `.concord/.gitignore` containing `*`, so the generated
workspace ignores itself and stays local without editing the repository's shared
`.gitignore`. Teams that want selected artifacts in PRs can add negation rules to
that file (setup keeps existing rules, only ensuring the `*` catch-all) or
force-add the human-readable files. Repositories set up by Concord 0.10.5 or
earlier also have a `.concord/` rule in the root `.gitignore`; remove it before
negations in `.concord/.gitignore` can take effect.

```text
.concord/
├── .gitignore          ignores the whole directory
├── concord.db          local source of truth
├── HANDOFF.md          human-readable handoff
├── REVIEW_PACKET.md    review-ready evidence
└── WORK_STATE.json     generated export (optional)
```

## CLI

Concord supports both typed MCP tools and a regular CLI. MCP-capable agents can
call the tools directly; humans and CLI-oriented agents can work with the same
shared workspace through `concord` commands.

```bash
concord setup                # set up local state, instructions, and MCP clients
concord status               # roster, active work, overlaps, stale claims, review-ready
concord dashboard            # live, keyboard-driven view of agents, tasks, alerts, and activity
concord who                  # which agents are present and what they are working on
concord tasks                # list all tracked tasks
concord handoff <task-id>    # print the latest handoff
concord review-packet <id>   # print the latest review packet
concord export markdown      # regenerate .concord/ artifacts
concord doctor               # workspace checks + per-task tool adoption
concord adapters status      # global harness delivery capability matrix

concord --repo ../project status        # select by repository path from anywhere
concord --workspace ws_... status       # select an id returned by a Concord operation
```

`--repo` and `--workspace` are global, mutually exclusive options. The CLI uses
the same `CONCORD_REPO_ROOT` → `CLAUDE_PROJECT_DIR` → working-directory priority
and the same linked-worktree canonicalization as MCP.

`concord dashboard` is a read-only, full-screen local TUI. It refreshes from the
shared SQLite workspace every second while keeping agents, tasks, alerts,
context, and timeline inside a fixed terminal viewport. Use `Tab` to change
panes, `j`/`k` or the arrow keys to select work, `/` to filter, `?` for help,
and `q` to quit.

## Upgrade

```bash
npm install -g @concord-ai/concord-mcp@latest
concord --version
```

Concord checks daily and surfaces available updates in the CLI, MCP tools, and
dashboard; `concord setup` can install one with confirmation, and
`CONCORD_NO_UPDATE_CHECK=1` disables checks.

## What this is / is not

Shared work-state and task memory for coding agents using the same local
checkout. **Not** an orchestrator, code reviewer, hosted sync service, memory
vector DB, or autonomous coding agent.

See also: [Why not just use markdown?](./docs/why-not-markdown.md)

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) and [`CLAUDE.md`](./CLAUDE.md). This
repo is strictly typed (no `any`, no typecasts) and modular. Good first issues
are labelled [`good first issue`](https://github.com/Get-Concord-AI/concord-mcp/labels/good%20first%20issue).

## Star History

<a href="https://www.star-history.com/?repos=Get-Concord-AI%2Fconcord-mcp&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Get-Concord-AI/concord-mcp&type=date&theme=dark&legend=top-left&sealed_token=PLqZk9LDZSite53TJb5bwyYask4-B5wAFxLcp3Ki_mJ3KlMtSpH09lN3ohwJuoQNs5Kwg_0zPG2DEwcRzJZvCIP1Md6vMdHjNwF_WkjuX6gd44wkwWFzqrAWgXGx2bPFEuJFRhmuWUlbRLnPOw6uW7cVJzrlcxprXCDU3_hHmUlHaFjVjQulH7EkfyuA" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Get-Concord-AI/concord-mcp&type=date&legend=top-left&sealed_token=PLqZk9LDZSite53TJb5bwyYask4-B5wAFxLcp3Ki_mJ3KlMtSpH09lN3ohwJuoQNs5Kwg_0zPG2DEwcRzJZvCIP1Md6vMdHjNwF_WkjuX6gd44wkwWFzqrAWgXGx2bPFEuJFRhmuWUlbRLnPOw6uW7cVJzrlcxprXCDU3_hHmUlHaFjVjQulH7EkfyuA" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=Get-Concord-AI/concord-mcp&type=date&legend=top-left&sealed_token=PLqZk9LDZSite53TJb5bwyYask4-B5wAFxLcp3Ki_mJ3KlMtSpH09lN3ohwJuoQNs5Kwg_0zPG2DEwcRzJZvCIP1Md6vMdHjNwF_WkjuX6gd44wkwWFzqrAWgXGx2bPFEuJFRhmuWUlbRLnPOw6uW7cVJzrlcxprXCDU3_hHmUlHaFjVjQulH7EkfyuA" />
 </picture>
</a>

## Privacy & telemetry

Concord sends product and coordination telemetry to `getconcord.ai`. It includes
random installation/invocation identifiers; irreversible per-install workspace
and task-flow pseudonyms; Concord/Node/platform versions; normalized client
metadata; operation names, outcomes, and durations; aggregate overlap/edit-guard
results; message delivery stages and latencies; task lifecycle transitions and
elapsed time; and explicitly reported acceptance,
integration, human-intervention, and rework outcomes.

Concord never sends code, raw file or repository paths, remotes, usernames, raw
task or agent identifiers, message identifiers or content, command arguments,
tool inputs/outputs, or task content. The receiving server stores the request IP
address and derives/stores a country code. Those server-side fields currently
have no automatic expiry. Set `CONCORD_TELEMETRY_DISABLED=1` (or
`DO_NOT_TRACK=1`) to disable telemetry. Delivery is best effort and can never
make a Concord operation fail.

## License

[MIT](./LICENSE)
