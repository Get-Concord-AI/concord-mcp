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
- **OpenCode, Grok, Kiro, Cursor, Antigravity (`agy`)** run their usual CLIs
  and read their usual user-level config.

## Coverage by provider

Coverage follows whichever vendor agent the thread runs — T3 contributes the
launch, not the integration. The whole matrix — this table and the delivery
table under [Message delivery](#message-delivery) — is inferred from how T3
launches each agent and from each harness's own documentation; none of it has
been exercised in a live T3 session. Rows marked "Unverified" are the least
certain. Check `concord status` inside a thread before relying on a given
provider; once real threads have been run, the verified rows can be promoted
and #230 closed.

| T3 provider         | Concord path                                           | Delivery                                                                             |
| ------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Claude Code         | MCP + `concord-relay` plugin (SDK session)             | Hooks while busy; `asyncRewake` waiter wakes idle sessions                           |
| Codex               | `[mcp_servers.concord]` + `[[hooks.*]]` in config.toml | Hooks while busy; managed host attaches too — see below                              |
| OpenCode            | `opencode.json` MCP + request-metadata identity        | Identified but not hosted — agent reads its inbox via `inspect_work`                 |
| Grok Build          | `~/.grok/config.toml` MCP + hooks                      | Hooks while busy; agent-started monitor for idle                                     |
| Kiro                | `~/.kiro` user MCP + hooks                             | Next prompt only — Kiro has no mid-turn hook                                         |
| Cursor              | `~/.cursor/mcp.json` MCP                               | Unverified — T3 drives `cursor-agent`, not the `cursor` binary                       |
| Antigravity (`agy`) | `.agents/mcp_config.json` + `~/.gemini/config`         | Hooks while busy; one-shot `inbox watch` monitor can wake idle — unverified under T3 |
| ACP agents          | Agent-dependent                                        | Unverified per agent — see below                                                     |

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

| Harness     | Busy turn                                | Idle session                                                           |
| ----------- | ---------------------------------------- | ---------------------------------------------------------------------- |
| Claude Code | PostToolUse and Stop hooks               | `asyncRewake` waiter (see below)                                       |
| Codex       | Hooks                                    | Next prompt — see below                                                |
| OpenCode    | Agent reads its inbox via `inspect_work` | Waits until the agent checks                                           |
| Grok Build  | Hooks                                    | Agent-started `concord inbox watch` monitor                            |
| Kiro        | None — no mid-turn hook                  | Next prompt (`UserPromptSubmit` drain)                                 |
| Antigravity | Hooks                                    | One-shot `inbox watch --once` monitor wakes idle — unverified under T3 |

**Claude Code.** T3 Code drives Claude through the Claude Agent SDK
(`CLAUDE_CODE_ENTRYPOINT=sdk-ts`), and the SDK never starts plugin monitors —
the same situation Conductor creates. Concord already handles it: the
`concord-relay` plugin's Stop hook arms `concord inbox rewake`, a Claude Code
[`asyncRewake`](https://code.claude.com/docs/en/hooks#run-hooks-in-the-background)
hook that waits for the agent's next message and wakes the session even when
idle. Every turn re-arms it, so each thread has one waiter. No T3-specific
setup is needed.

**Codex.** T3 Code runs `codex app-server` itself and owns the thread's
writer — but Concord cannot tell. `codexThreadHostable` only excludes
sessions running under Conductor (`CONDUCTOR_SESSION_ID`), and T3 Code sets
no equivalent marker. So the `SessionStart` hook in `~/.codex/config.toml`
launches Concord's managed host (`concord adapters host-codex`) for T3
threads too: it resumes the thread through `codex app-server proxy` and can
start turns in Concord's daemon. Those turns write the same rollout from a
second process that T3's UI never shows — a competing writer, the same
hazard Conductor is excluded for. To opt out, edit `config.toml` and remove
only Concord's hook entries and the `# >>> concord hooks >>>` /
`# <<< concord hooks <<<` marker lines — keep any `[hooks.state]` tables Codex
appended inside the fence, since deleting them erases your trust decisions
for unrelated hooks and Codex will re-prompt for them. Do this before
starting T3 Codex sessions if you can, since the `SessionStart` hook is what
launches the host. The block only gates future launches: a host already
running for a thread is a detached `concord adapters host-codex` process that
keeps delivering until you end it in Task Manager or `ps`/`kill`. Re-running
`concord setup` — or the adapter self-heal path when `autoAdapters` is on —
writes the block back, so the opt-out is not permanent unless you avoid
those. The thread keeps MCP tool access but loses hook-driven identity and
delivery.

## Caveats

- **Codex competing writer.** Concord's managed host attaches to T3 Code Codex
  threads — T3 sets no embedding-host marker, so `codexThreadHostable` treats
  them as hostable — and can start turns in its own daemon that T3's UI never
  shows, writing the same rollout. Opting out means removing Concord's hook
  entries and marker lines from `config.toml` — keeping any `[hooks.state]`
  trust tables Codex wrote inside the fence — **and** killing any `host-codex`
  process already running for the thread; `concord setup` writes the block
  back — see [Message delivery](#message-delivery).
- **Managed provider runtimes.** T3 Code's "Connect with ChatGPT" Codex
  instance and managed Antigravity use T3-managed config directories, not
  `~/.codex` or `~/.gemini/config`. Concord's registrations do not reach them.
  Use provider instances backed by your own CLI login ("Configure manually",
  or the installed `codex`/`agy` binary) for Concord coverage.
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
as Concord agents. Send a message from one thread to the other, and read it
in the receiving thread with `inspect_work`. That exercises the delivery
paths Concord actually supports under T3 — hooks while busy, the
`asyncRewake` waiter for an idle Claude session, and `inspect_work` pulls —
without relying on the Codex managed host.
