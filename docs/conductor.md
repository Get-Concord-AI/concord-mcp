# Using Concord with Conductor

[Conductor](https://www.conductor.build/docs) is a Mac app that runs several
coding agents at once, each in its own git worktree. Concord works inside local
Conductor workspaces for Claude Code and Codex chats. No Conductor-specific
setup is needed: Conductor loads each harness's own configuration, so the
global setup you already have carries over.

## Set up

```bash
npm install -g @concord-ai/concord-mcp
concord setup
```

Conductor runs its bundled Claude Code and Codex (or the system binaries, if you
configure them) with your user settings:

- **Claude Code** loads `~/.claude/settings.json`, the project's settings, and
  your installed plugins, so the `concord-relay` plugin and its hooks load. MCP
  servers come from `~/.claude.json` and the project's `.mcp.json`.
- **Codex** loads `~/.codex/config.toml`, so Concord's MCP server and hooks load.

Conductor documents this in its [MCP reference](https://www.conductor.build/docs/reference/mcp):
"Conductor does not define a separate MCP config format."

Each Conductor workspace is a git worktree under
`~/conductor/workspaces/<repo>/<workspace>`. Concord resolves a worktree to its
repository, so every workspace of a repository shares one Concord workspace.
Gitignored files are not copied into new workspaces. If you keep Concord's
`.mcp.json` or `.concord/` out of git, list them in the repository's
[files to copy](https://www.conductor.build/docs/reference/files-to-copy), or
rely on the user-level MCP config instead.

## Identity

Each Conductor chat is its own Concord agent. A Claude Code chat is
`claude-code:<hash of its session id>`, and a Codex chat is
`codex:<hash of its thread id>`. Conductor keeps the native session id when it
resumes a chat, so the agent id survives an app restart. Two chats in one
workspace are two agents.

## Message delivery

| Harness     | Busy turn                  | Idle session                     |
| ----------- | -------------------------- | -------------------------------- |
| Claude Code | PostToolUse and Stop hooks | `asyncRewake` waiter (see below) |
| Codex       | PostToolUse and Stop hooks | Next prompt in Conductor         |

**Claude Code.** Conductor drives Claude Code through the Claude Agent SDK, and
the SDK never starts plugin monitors, so the relay plugin's usual idle wakeup
does not run. Instead, the plugin's Stop hook arms
`concord inbox rewake`, a Claude Code
[`asyncRewake`](https://code.claude.com/docs/en/hooks#run-hooks-in-the-background)
hook. It waits in the background for this agent's next message. When one
arrives, it prints the message and exits with code 2, which "wakes Claude
immediately even when the session is idle". Every turn re-arms it, and a newer waiter
replaces the old one, so each session has one. The waiter runs only in
SDK-hosted sessions (`CLAUDE_CODE_ENTRYPOINT` is `sdk-ts` or `sdk-py`).
Interactive terminal sessions keep the native monitor.

Conductor replaces `AskUserQuestion` with its own `mcp__conductor__AskUserQuestion`.
Concord treats either one as the agent waiting on its user.

**Codex.** Conductor runs `codex app-server` itself, over stdio, and that
process is the thread's only writer. Concord's Codex host starts idle turns
through a separate app-server, and Codex refuses to resume a thread there while
Conductor holds it ("thread … already has an active writer"). So in a Conductor
session (`CONDUCTOR_SESSION_ID` is set), Concord does not start the host, and
`concord adapters host-codex` refuses to run. Messages reach the agent through
its PostToolUse and Stop hooks during a turn. A message sent while the chat is
idle waits for its next turn: Codex hooks cannot wake an idle session, a
finished background command does not wake one either, and the
[Conductor API](https://www.conductor.build/docs/api), which can send a prompt
to a session, covers cloud workspaces only.

## Not covered

- **Cloud workspaces.** These run on Conductor's machines, not yours.
- **Cursor chats.** These run through the Cursor API, not a local process.
- **OpenCode chats.** Concord has no OpenCode adapter yet.

## Check it

```bash
concord doctor
concord status
```

Ask an agent in one Conductor chat to message an agent in another chat. Leave
the second chat idle. A Claude Code chat starts a turn by itself. A Codex chat
shows the message the next time it runs.
