# Using Concord with Codex

## 1. Install

```bash
npm install -g @concord-ai/concord-mcp
```

## 2. Set up your repo

```bash
concord setup
```

This creates `.concord/` and registers the MCP server in your Codex config
(`~/.codex/config.toml`, or `$CODEX_HOME/config.toml` when that is set):

```toml
[mcp_servers.concord]
command = "concord-mcp"
```

and writes a Concord block into `AGENTS.md` (and `.codex/concord.md`) describing
when to claim work, share task context, and hand off. The rest of your config —
other tables, and the comments around them — is left as-is, and re-running is a
no-op. Pass `--no-mcp` to write only the instructions and add the table above
yourself.

Note this is the one file `concord setup` writes outside the repo, since Codex
keeps MCP servers in user-global config rather than per-project. Refer to the
current Codex MCP documentation if the config format has changed.

## 3. Use it

Codex should call `start_work` before editing, `update_work` while working, and
`inspect_work` when resuming or coordinating. Assignments, acceptance, and
handoffs use `transfer_work` with the task's current version. Before a PR it
calls `finish_work` with `outcome: "review_ready"` and the evidence needed for
review. Track it from your terminal:

```bash
concord status
concord doctor
```

`concord setup` installs lifecycle hooks and attempts to bootstrap Codex's
managed app-server daemon with remote control enabled. On SessionStart the hook
launches a per-session Concord bridge. The bridge uses the official
`turn/steer` request with `expectedTurnId` while a turn is active and
`turn/start` while idle. If the daemon or bridge probe fails, the endpoint keeps
the hook-based pull fallback and reports that the message is queued instead of
claiming immediate delivery.

Codex app-server delivery is version-gated to the verified protocol baseline.
Run `concord adapters doctor` after upgrades; `unsupported_version` deliberately
fails closed until the adapter contract is updated.

The `codex app-server proxy` transport speaks WebSocket to the daemon's control
socket. That subcommand first shipped in Codex 0.125.0 (2026-04) already
speaking WebSocket — no released version proxies JSON lines, so there is no
older-protocol fallback to keep.

Bare Codex CLI does support session-owned background terminals (visible through
`/ps` and stoppable with `/stop`), but terminal completion does not start a new
model turn. Codex's asynchronous hook contract has the same boundary: output is
delivered at the next safe point during an active turn, or waits for the next
user turn when idle. A background `concord inbox watch` therefore cannot replace
the app-server controller for idle wakeup. Concord uses `turn/steer` for a busy
turn and `turn/start` for an idle thread instead. See the official
[Codex developer commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
and [hooks behavior](https://learn.chatgpt.com/docs/hooks).

> Codex asks you to trust newly installed hooks. Until they are trusted, the
> bridge cannot learn the native session id and delivery is degraded.
