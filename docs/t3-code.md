# Using Concord with T3 Code

[T3 Code](https://t3.codes) ([github.com/pingdotgg/t3code](https://github.com/pingdotgg/t3code))
is an open-source control plane that runs coding agents — Claude Code, Codex,
Cursor, OpenCode, Grok Build, Antigravity, Kiro, and ACP agents — in threads on
your machine, each optionally in its own git worktree. T3 Code is not an agent
itself: it launches the same vendor CLIs you would run by hand, with your own
logins and config directories, and adds its own interface on top. Concord works
inside T3 Code threads through each harness's existing integration — there is
no T3-specific setup.

T3 Code is the same kind of app as [Conductor](./conductor.md): an orchestrator
that drives other agents. The differences that matter for Concord are noted
below.

## Set up

```bash
npm install -g @concord-ai/concord-mcp
concord setup
```

Because T3 Code threads often run in fresh git worktrees, where untracked
files do not exist, user-level registration is the robust path:

```bash
concord setup --global
```

Global mode writes each harness's user-level MCP registration and instructions
(`claude mcp add --scope user`, `~/.codex/config.toml`, `~/.cursor/mcp.json`,
`~/.grok/config.toml`, `~/.kiro`, and so on), so it applies in every directory
and every worktree. Add `--repo-files` if you also want the project files.

Each T3 provider instance uses the vendor's own binary and config:

- **Claude** runs through the Claude Agent SDK with your `CLAUDE_CONFIG_DIR`.
  User and project settings load, `~/.claude.json` and `.mcp.json` MCP servers
  load, and plugins under `~/.claude/skills/` — including `concord-relay` —
  load. T3 adds its own `t3-code` MCP server alongside them; it does not
  replace yours.
- **Codex** runs `codex app-server` against `CODEX_HOME` (`~/.codex` by
  default), so `[mcp_servers.concord]` and the `[[hooks.*]]` tables in
  `config.toml` apply.
- **OpenCode, Grok, Kiro, and Cursor** run their usual CLIs and read their
  usual user-level config. **Antigravity** is different: even when T3 uses a
  manual `agy` binary, T3 manages its own Antigravity profile/sign-in, so a
  terminal login that works for `agy models` does not by itself authenticate
  T3's provider instance.

## Coverage by provider

Coverage follows whichever vendor agent the thread runs — T3 contributes the
launch, not the integration. Live smoke validation in T3 Code 0.1.12 has
exercised Claude Code, Codex, and OpenCode registration through Concord MCP,
shared workspace resolution across a T3-created git worktree, and Claude
mid-turn hook delivery. The remaining rows and idle-wake behavior are still
inferred from each harness's own documentation. Check `concord status` inside
a thread before relying on a given provider; do not treat an unmarked row as
live-verified.

| T3 provider         | Concord path                                           | Delivery                                                                                                                                                       |
| ------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code         | MCP + `concord-relay` plugin (SDK session)             | MCP registration and busy-turn PostToolUse delivery verified; idle `asyncRewake` wake still unverified under T3                                                |
| Codex               | `[mcp_servers.concord]` + `[[hooks.*]]` in config.toml | MCP registration and hook-derived identity verified; payload-derived inbox delivery verified on a later prompt; managed-host risk remains inferred — see below |
| OpenCode            | `opencode.json` MCP + request-metadata identity        | MCP registration verified; still not hosted — agent reads its inbox via `inspect_work`                                                                         |
| Grok Build          | `~/.grok/config.toml` MCP + hooks                      | Hooks while busy; agent-started monitor for idle                                                                                                               |
| Kiro                | `~/.kiro` user MCP + hooks                             | Next prompt only — Kiro has no mid-turn hook                                                                                                                   |
| Cursor              | `~/.cursor/mcp.json` MCP                               | Unverified — T3 drives `cursor-agent`, not the `cursor` binary                                                                                                 |
| Antigravity (`agy`) | `.agents/mcp_config.json` + `~/.gemini/config`         | Unverified under T3 — T3 uses its own Antigravity sign-in/profile, so local `agy` authentication is not evidence of T3 access                                  |
| ACP agents          | Agent-dependent                                        | Unverified per agent — see below                                                                                                                               |

## Identity

Each T3 thread is its own agent session, so each becomes a distinct Concord
agent: a Claude thread is `claude-code:<hash of its session id>`, a Codex
thread is `codex:<hash of its thread id>`, and so on. Two threads in the same
project are two agents that can message each other. Resuming a thread keeps
its native session id, so the Concord agent id survives restarts.

## Worktrees and untracked files

T3 Code can run a thread in the project folder or in a dedicated git worktree.
Concord resolves a linked worktree to the repository's primary `.concord/`
store, so every thread of a repository shares one Concord workspace — claims
and messages are visible across threads.

Gitignored or untracked files are not copied into a new worktree. The shared
`.concord/` store itself resolves to the primary checkout, so it is not at
risk — but Concord's per-client config files are. If you keep them (`.mcp.json`,
`.cursor/mcp.json`, `.claude/` hooks) out of git, they will be missing inside
worktree threads. Prefer `concord setup --global`, or commit the project files
you want shared.

## Message delivery

| Harness     | Busy turn                                | Idle session                                                                      |
| ----------- | ---------------------------------------- | --------------------------------------------------------------------------------- |
| Claude Code | PostToolUse verified; Stop inferred      | `asyncRewake` waiter — not observed in live T3 smoke; treat idle as unproven      |
| Codex       | Hook drain into payload-derived inbox    | Next prompt — verified for payload-derived id; explicit-id inboxes stay pull-only |
| OpenCode    | Agent reads its inbox via `inspect_work` | Waits until the agent checks — registration verified, delivery unverified         |
| Grok Build  | Hooks                                    | Agent-started `concord inbox watch` monitor                                       |
| Kiro        | None — no mid-turn hook                  | Next prompt (`UserPromptSubmit` drain)                                            |
| Antigravity | Hooks                                    | One-shot `inbox watch --once` monitor wakes idle — unverified under T3            |

**Claude Code.** T3 Code drives Claude through the Claude Agent SDK
(`CLAUDE_CODE_ENTRYPOINT=sdk-ts`). Live validation observed Claude loading
Concord MCP, registering in a T3-created git worktree, resolving the same
workspace as threads in the project checkout, and receiving a queued peer
message mid-turn through the PostToolUse hook. The send operation still
reported `queued_pull`: this is hook-mediated delivery into the active turn,
not proof that Concord can wake an idle T3 Claude thread. The `concord-relay`
`asyncRewake` waiter should provide idle wake-up in a normal Claude Code
session, but live T3 smoke did not reproduce it: after the turn completed, a
message to the registered Claude agent stayed queued, no new T3 run started,
and no `concord inbox rewake` process was present. Treat idle Claude wake-up
under T3 as unproven until a positive observation exists.

**Codex.** T3 Code runs `codex app-server` itself and owns the thread's
writer — but Concord cannot tell. `codexThreadHostable` only excludes
sessions running under Conductor (`CONDUCTOR_SESSION_ID`), and T3 Code sets
no equivalent marker. So the `SessionStart` hook in `~/.codex/config.toml`
launches Concord's managed host (`concord adapters host-codex`) for T3
threads too: it resumes the thread through `codex app-server proxy` and can
start turns in Concord's daemon. Those turns write the same rollout from a
second process that T3's UI never shows — a competing writer, the same
hazard Conductor is excluded for.

The recommended setup for T3 Codex threads is to disable the managed host
while keeping hook delivery. Of the three hook entries inside the
`# >>> concord hooks >>>` fence, only the `SessionStart` one launches the
host (`concord inbox register`); the `PostToolUse` and `Stop` entries are
drains — they deliver waiting messages into the turn and start nothing. So
in `~/.codex/config.toml`, delete only the `SessionStart` entry — the
`[[hooks.SessionStart]]` and `[[hooks.SessionStart.hooks]]` table headers
with their `type`/`command` lines — and keep the two drain entries, the
fence markers, and any `[hooks.state]` tables Codex appended inside the
fence. Deleting the `[hooks.state]` tables erases your trust decisions for
unrelated hooks and Codex will re-prompt for them. Do this before starting
T3 Codex sessions if you can, since only a future `SessionStart` can launch
a host: one already running for a thread is a detached
`concord adapters host-codex` process that keeps delivering until you end it
in Task Manager or `ps`/`kill`. Re-running `concord setup` — or the adapter
self-heal path when `autoAdapters` is on — writes the full block back, so
the host opt-out is not permanent unless you avoid those.

One consequence matters, and live validation reproduced it: the hook-derived
Codex identity is separate from any explicit `agent_id` the model chooses. In
the live T3 run, `start_work` with explicit `codex:t3-live-project` succeeded
through MCP, while the hooks independently registered `codex:<hash>`; messages
to the explicit id stayed queued even during a busy turn, while a message to
the payload-derived id was delivered and read on the next prompt.

With the `SessionStart` entry removed, the model never learns that hook-derived
id — and it cannot fall back on session-derived identity either, because Codex
spawns its MCP servers with a scrubbed environment and passes the session id
only to hook payloads. So treat an explicit `agent_id` as required, not
optional: choose a unique id per thread and pass it on every workflow call.
That explicit id is what gives the thread stable task ownership, but it is not
the inbox the Codex drain hooks empty. Send operational messages to the
payload-derived id when that is the identity the hooks registered, or read an
explicit-id inbox with `inspect_work` using the same id. Once the thread has
made its first tool call, peers can find its `codex:<hash>` id with
`concord who` or `inspect_work`; until then, target the explicit id and
expect pull-only delivery. Never reuse one explicit id across threads: two
threads sharing an id claim as each other.
Keeping the two drain entries is therefore worth it even though part of the
delivery becomes pull-based — and removing them as well takes the thread
fully down to `inspect_work`-only: nothing is pushed into a busy turn at all.

## Caveats

- **Codex competing writer.** Concord's managed host attaches to T3 Code Codex
  threads — T3 sets no embedding-host marker, so `codexThreadHostable` treats
  them as hostable — and can start turns in its own daemon that T3's UI never
  shows, writing the same rollout. The recommended setup removes only the
  `SessionStart` hook entry from `config.toml` — keeping the drain entries,
  the marker lines, and any `[hooks.state]` trust tables Codex wrote inside
  the fence — **and** killing any `host-codex` process already running for
  the thread; `concord setup` writes the block back — see
  [Message delivery](#message-delivery).
- **Managed provider runtimes.** T3 Code's "Connect with ChatGPT" Codex
  instance and managed Antigravity use T3-managed config directories, not
  `~/.codex` or `~/.gemini/config`. Concord's registrations do not reach them.
  Use provider instances backed by your own CLI login where T3 actually
  reuses it ("Configure manually", or the installed `codex` binary). For
  Antigravity, using the installed `agy` binary is not enough by itself: T3
  still keeps its own Antigravity sign-in/profile, so complete that sign-in
  in T3 before expecting Concord coverage.
- **ACP agents.** Registry and local-command ACP agents (Pi, Muse Code, fx,
  `dsh --profile acp`, and others) are driven over the Agent Client Protocol.
  Which MCP servers they load is decided per agent — some take them from the
  ACP client (T3 Code), some read their own config. Coverage is per-agent and
  unverified; an agent that cannot host MCP can still use
  [`concord work`](../README.md#shell-only-agents-concord-work) from a shell.
- **Cursor.** T3 Code drives the `cursor-agent` binary. Concord's Cursor
  integration targets the `cursor` harness, so coverage under T3 Code is
  unverified.
- **T3 Code's own MCP server.** T3 Code exposes `/mcp` so that _outside_ agents
  (Claude Code in your terminal, ChatGPT, bots) can read and drive T3 threads.
  That is the reverse direction from Concord and does not interact with it.
- **Remote environments.** When T3 Code runs agents on another machine (T3
  Connect, LAN, Tailscale, WSL), Concord state lives on that machine — install
  and set up Concord there, not on the client you connect from.

## Not covered

- T3-managed provider runtimes (ChatGPT-connected Codex, managed Antigravity).
- ACP agents that do not read their own MCP configuration.
- Anything specific to T3 Code's UI, worktree management, or `t3 thread`
  scripting — those are T3's features, not Concord's.

## Check it

```bash
concord doctor
concord status
concord adapters status
```

Then start two threads in the same project — a Claude thread and a Codex
thread, say — and have each run `start_work` on a small task so both register
as Concord agents. Send a message from one thread to the other.

Reading it back in the receiving thread with `inspect_work` proves the shared
workspace, registration, and the pull path — nothing more: that read succeeds
even if every push path is broken. To verify push delivery, watch the
receiving thread without pulling. A message sent to a thread mid-turn should
surface in the turn on its own through the `PostToolUse` or `Stop` hook. If
idle wake-up works, a message sent to an idle Claude thread should start a new
turn within seconds through the `asyncRewake` waiter; if nothing starts, that
path is not working in this embedded host. Live validation has now observed MCP
registration, cross-worktree shared workspace resolution, Claude mid-turn hook
delivery, and Codex payload-derived inbox delivery inside T3. It affirmatively
did not observe Claude idle wake-up after turn completion in the smoke
environment, and it has not observed Antigravity authenticated through T3,
Devin as a local ACP agent, or the Codex managed host writing a hidden turn.
Those rows remain inferred or explicitly blocked rather than verified — which
is why this guide references rather than closes #230.
